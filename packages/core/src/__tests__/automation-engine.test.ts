import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, and, adminDb as admin } from "@kompast/db";
import { createProject } from "../project";
import { createIssue, moveIssue } from "../issue";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";
import { createWorkflow } from "../automation-workflow";
import { claimPendingWorkflowEvents, matchAndStartRuns, advanceWorkflowStep, claimDueWorkflowSteps } from "../automation-engine";
import { MAX_AUTOMATION_DEPTH } from "../automation-execution";

describe("automation engine", () => {
  const orgId = "test-engine-org";
  const userId = "test-engine-user";
  const teamId = "test-engine-team";
  const ctx = { userId, organizationId: orgId };

  async function cleanup() {
    await admin.delete(schema.automationWorkflowEvent).where(eq(schema.automationWorkflowEvent.organizationId, orgId));
    await admin.delete(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.organizationId, orgId));
    await admin.delete(schema.automationWorkflow).where(eq(schema.automationWorkflow.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Engine Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });
  });

  afterAll(cleanup);

  async function seedProjectAndIssue(key: string) {
    const { projectId, issueTypes, statuses } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key, name: key, actorUserId: userId }),
    );
    const { issueId } = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Engine test issue", reporterId: userId }),
    );
    return { projectId, issueId, statuses };
  }

  async function latestWorkflowEventFor(issueId: string, eventType: string) {
    const rows = await admin.select().from(schema.automationWorkflowEvent).where(and(eq(schema.automationWorkflowEvent.entityId, issueId), eq(schema.automationWorkflowEvent.eventType, eventType)));
    return rows.at(-1)!;
  }

  async function runAllSteps(runId: string) {
    // Drains every pending/waiting-and-due step for this run — a small test helper, not part of the public engine API.
    for (let i = 0; i < 20; i++) {
      const steps = await admin.select().from(schema.automationWorkflowRunStep).where(and(eq(schema.automationWorkflowRunStep.runId, runId), eq(schema.automationWorkflowRunStep.status, "pending")));
      if (steps.length === 0) return;
      for (const step of steps) await withAuthorizedTenant(ctx, (tx) => advanceWorkflowStep(tx, step));
    }
    throw new Error("runAllSteps: did not converge after 20 iterations");
  }

  it("a trigger_event node fans out to two independent action branches, both applied", async () => {
    const { projectId, issueId, statuses } = await seedProjectAndIssue("ena");
    const triggerId = id("anode");
    const labelActionId = id("anode");
    const commentActionId = id("anode");
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId,
        name: "Fan-out test",
        createdBy: userId,
        nodes: [
          { id: triggerId, type: "trigger_event", config: { eventType: "issue.transitioned" }, position: { x: 0, y: 0 } },
          { id: labelActionId, type: "action_add_label", config: { label: "fanned-out-1" }, position: { x: 200, y: -50 } },
          { id: commentActionId, type: "action_comment", config: { text: "fanned-out-2" }, position: { x: 200, y: 50 } },
        ],
        edges: [
          { fromNodeId: triggerId, toNodeId: labelActionId },
          { fromNodeId: triggerId, toNodeId: commentActionId },
        ],
      }),
    );

    await withAuthorizedTenant(ctx, (tx) => moveIssue(tx, { issueId, toStatusId: statuses[2]!.id, actorId: userId }));
    const event = await latestWorkflowEventFor(issueId, "issue.transitioned");
    await withAuthorizedTenant(ctx, (tx) => matchAndStartRuns(tx, event));

    const runs = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowId));
    expect(runs).toHaveLength(1);
    await runAllSteps(runs[0]!.id);

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.labels).toEqual(["fanned-out-1"]);
    const comments = await admin.select().from(schema.issueComment).where(eq(schema.issueComment.issueId, issueId));
    expect(comments).toHaveLength(1);

    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runs[0]!.id));
    expect(run!.status).toBe("completed");
  });

  it("condition_property's false branch takes no action and its true-only downstream is never visited", async () => {
    const { projectId, issueId, statuses } = await seedProjectAndIssue("enb");
    const triggerId = id("anode");
    const conditionId = id("anode");
    const actionId = id("anode");
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId,
        name: "Branch test",
        createdBy: userId,
        nodes: [
          { id: triggerId, type: "trigger_event", config: { eventType: "issue.transitioned" }, position: { x: 0, y: 0 } },
          { id: conditionId, type: "condition_property", config: { property: "priority", operator: "eq", value: "highest" }, position: { x: 200, y: 0 } },
          { id: actionId, type: "action_add_label", config: { label: "should-not-appear" }, position: { x: 400, y: 0 } },
        ],
        edges: [
          { fromNodeId: triggerId, toNodeId: conditionId },
          { fromNodeId: conditionId, fromHandle: "true", toNodeId: actionId },
        ],
      }),
    );

    await withAuthorizedTenant(ctx, (tx) => moveIssue(tx, { issueId, toStatusId: statuses[2]!.id, actorId: userId }));
    const event = await latestWorkflowEventFor(issueId, "issue.transitioned");
    await withAuthorizedTenant(ctx, (tx) => matchAndStartRuns(tx, event));
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowId));
    await runAllSteps(run!.id);

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.labels).toEqual([]);
    const steps = await admin.select().from(schema.automationWorkflowRunStep).where(eq(schema.automationWorkflowRunStep.runId, run!.id));
    expect(steps).toHaveLength(2); // trigger + condition only, action never visited
  });

  it("a disabled workflow is never matched", async () => {
    const { projectId, issueId, statuses } = await seedProjectAndIssue("enc");
    const triggerId = id("anode");
    const actionId = id("anode");
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId,
        name: "Disabled workflow",
        createdBy: userId,
        nodes: [
          { id: triggerId, type: "trigger_event", config: { eventType: "issue.transitioned" }, position: { x: 0, y: 0 } },
          { id: actionId, type: "action_add_label", config: { label: "should-not-appear" }, position: { x: 200, y: 0 } },
        ],
        edges: [{ fromNodeId: triggerId, toNodeId: actionId }],
      }),
    );
    await admin.update(schema.automationWorkflow).set({ enabled: false }).where(eq(schema.automationWorkflow.id, workflowId));

    await withAuthorizedTenant(ctx, (tx) => moveIssue(tx, { issueId, toStatusId: statuses[2]!.id, actorId: userId }));
    const event = await latestWorkflowEventFor(issueId, "issue.transitioned");
    await withAuthorizedTenant(ctx, (tx) => matchAndStartRuns(tx, event));

    const runs = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowId));
    expect(runs).toHaveLength(0);
  });

  it("a workflow's own action never re-triggers itself, but a different workflow still fires", async () => {
    const { projectId, issueId, statuses } = await seedProjectAndIssue("end");
    const triggerAId = id("anode");
    const actionAId = id("anode");
    const { workflowId: workflowAId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId,
        name: "Workflow A: comment -> transition",
        createdBy: userId,
        nodes: [
          { id: triggerAId, type: "trigger_event", config: { eventType: "issue.commented" }, position: { x: 0, y: 0 } },
          { id: actionAId, type: "action_set_property", config: { property: "status", value: statuses[2]!.id }, position: { x: 200, y: 0 } },
        ],
        edges: [{ fromNodeId: triggerAId, toNodeId: actionAId }],
      }),
    );
    const triggerBId = id("anode");
    const actionBId = id("anode");
    const { workflowId: workflowBId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId,
        name: "Workflow B: transition -> label",
        createdBy: userId,
        nodes: [
          { id: triggerBId, type: "trigger_event", config: { eventType: "issue.transitioned" }, position: { x: 0, y: 0 } },
          { id: actionBId, type: "action_add_label", config: { label: "chained" }, position: { x: 200, y: 0 } },
        ],
        edges: [{ fromNodeId: triggerBId, toNodeId: actionBId }],
      }),
    );

    const { addComment } = await import("../comment");
    await withAuthorizedTenant(ctx, (tx) => addComment(tx, { issueId, authorId: userId, bodyJson: { text: "trigger it" } }));
    const commentEvent = await latestWorkflowEventFor(issueId, "issue.commented");
    await withAuthorizedTenant(ctx, (tx) => matchAndStartRuns(tx, commentEvent));
    const [runA] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowAId));
    await runAllSteps(runA!.id);

    const transitionEvent = await latestWorkflowEventFor(issueId, "issue.transitioned");
    expect(transitionEvent.depth).toBe(1);
    expect(transitionEvent.causedByWorkflowId).toBe(workflowAId);

    await withAuthorizedTenant(ctx, (tx) => matchAndStartRuns(tx, transitionEvent));

    const workflowARunsAfter = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowAId));
    expect(workflowARunsAfter).toHaveLength(1); // no second run for A from its own resulting event

    const workflowBRuns = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowBId));
    expect(workflowBRuns).toHaveLength(1);
    await runAllSteps(workflowBRuns[0]!.id);
    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.labels).toEqual(["chained"]);
  });

  it("a branch past MAX_AUTOMATION_DEPTH is skipped, but sibling branches from the same fan-out still complete", async () => {
    const { projectId, issueId, statuses } = await seedProjectAndIssue("ene");
    const triggerId = id("anode");
    const shallowActionId = id("anode");
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId,
        name: "Depth test",
        createdBy: userId,
        nodes: [
          { id: triggerId, type: "trigger_event", config: { eventType: "issue.transitioned" }, position: { x: 0, y: 0 } },
          { id: shallowActionId, type: "action_add_label", config: { label: "shallow-branch-ok" }, position: { x: 200, y: 0 } },
        ],
        edges: [{ fromNodeId: triggerId, toNodeId: shallowActionId }],
      }),
    );

    await withAuthorizedTenant(ctx, (tx) => moveIssue(tx, { issueId, toStatusId: statuses[2]!.id, actorId: userId }));
    const event = await latestWorkflowEventFor(issueId, "issue.transitioned");
    await withAuthorizedTenant(ctx, (tx) => matchAndStartRuns(tx, event));
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowId));

    // Manually insert a step already at MAX_AUTOMATION_DEPTH to simulate a deep chain without building 5 real hops.
    const deepStepId = id("wfstep");
    await admin.insert(schema.automationWorkflowRunStep).values({ id: deepStepId, runId: run!.id, nodeId: shallowActionId, depth: MAX_AUTOMATION_DEPTH, status: "pending" });
    const [deepStep] = await admin.select().from(schema.automationWorkflowRunStep).where(eq(schema.automationWorkflowRunStep.id, deepStepId));
    await withAuthorizedTenant(ctx, (tx) => advanceWorkflowStep(tx, deepStep!));

    const [finishedDeepStep] = await admin.select().from(schema.automationWorkflowRunStep).where(eq(schema.automationWorkflowRunStep.id, deepStepId));
    expect(finishedDeepStep!.status).toBe("skipped_max_depth");

    await runAllSteps(run!.id);
    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.labels).toEqual(["shallow-branch-ok"]); // the REAL (depth-1) trigger step still ran normally
  });

  it("claimPendingWorkflowEvents and claimDueWorkflowSteps claim real rows end-to-end", async () => {
    const { projectId, issueId, statuses } = await seedProjectAndIssue("enf");
    const triggerId = id("anode");
    const actionId = id("anode");
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId,
        name: "Claim test",
        createdBy: userId,
        nodes: [
          { id: triggerId, type: "trigger_event", config: { eventType: "issue.transitioned" }, position: { x: 0, y: 0 } },
          { id: actionId, type: "action_add_label", config: { label: "claimed" }, position: { x: 200, y: 0 } },
        ],
        edges: [{ fromNodeId: triggerId, toNodeId: actionId }],
      }),
    );

    await withAuthorizedTenant(ctx, (tx) => moveIssue(tx, { issueId, toStatusId: statuses[2]!.id, actorId: userId }));

    // Both claim queries are unscoped, system-wide scans (real production
    // shape — see claimPendingWorkflowEvents/claimDueWorkflowSteps's own
    // doc comments) that can race other test FILES running concurrently
    // against the same Postgres (see CLAUDE.md's "vitest runs test files in
    // parallel" note). Filter down to only OUR own fixtures before
    // asserting/processing, the same way this file's OWN
    // claimPendingWorkflowEvents.filter(projectId) already does for events,
    // and the old engine's equivalent test does for automation_event —
    // never assume a stray pending/waiting row from another file can't be
    // in the claimed batch.
    const claimedEvents = await claimPendingWorkflowEvents(admin, 20);
    const ourEvents = claimedEvents.filter((e) => e.projectId === projectId);
    expect(ourEvents.length).toBeGreaterThanOrEqual(1);
    for (const event of ourEvents) await withAuthorizedTenant(ctx, (tx) => matchAndStartRuns(tx, event));

    const ourRuns = await admin.select({ id: schema.automationWorkflowRun.id }).from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowId));
    const ourRunIds = new Set(ourRuns.map((r) => r.id));

    const claimedSteps = await claimDueWorkflowSteps(admin, 20);
    const ourSteps = claimedSteps.filter((s) => ourRunIds.has(s.runId));
    expect(ourSteps.length).toBeGreaterThanOrEqual(1);
    for (const step of ourSteps) await withAuthorizedTenant(ctx, (tx) => advanceWorkflowStep(tx, step));

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.labels).toEqual(["claimed"]);
  });

  it("action_comment also respects self-trigger loop prevention (doesn't bypass it like the old bug did)", async () => {
    const { projectId, issueId } = await seedProjectAndIssue("eng");
    const triggerId = id("anode");
    const actionId = id("anode");
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId,
        name: "Comment loop test",
        createdBy: userId,
        nodes: [
          { id: triggerId, type: "trigger_event", config: { eventType: "issue.commented" }, position: { x: 0, y: 0 } },
          { id: actionId, type: "action_comment", config: { text: "auto-reply" }, position: { x: 200, y: 0 } },
        ],
        edges: [{ fromNodeId: triggerId, toNodeId: actionId }],
      }),
    );

    const { addComment } = await import("../comment");
    await withAuthorizedTenant(ctx, (tx) => addComment(tx, { issueId, authorId: userId, bodyJson: { text: "start it" } }));
    const firstCommentEvent = await latestWorkflowEventFor(issueId, "issue.commented");
    await withAuthorizedTenant(ctx, (tx) => matchAndStartRuns(tx, firstCommentEvent));
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowId));
    await runAllSteps(run!.id);

    const comments = await admin.select().from(schema.issueComment).where(eq(schema.issueComment.issueId, issueId));
    expect(comments).toHaveLength(2); // the human's + the workflow's own reply

    // The workflow's own comment must have emitted its own issue.commented
    // event, correctly attributed back to this workflow (not null/unset —
    // action_comment used to silently drop automationContext here).
    const secondCommentEvent = await latestWorkflowEventFor(issueId, "issue.commented");
    expect(secondCommentEvent.causedByWorkflowId).toBe(workflowId);

    // Re-running trigger matching against that self-caused event must NOT
    // start a second run for this same workflow.
    await withAuthorizedTenant(ctx, (tx) => matchAndStartRuns(tx, secondCommentEvent));
    const runsAfter = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowId));
    expect(runsAfter).toHaveLength(1);
  });

  it("a fan-out with one immediate sibling and one waiting (delay) sibling keeps the run running, then completes once the delay resumes", async () => {
    const { projectId, issueId, statuses } = await seedProjectAndIssue("enh");
    const triggerId = id("anode");
    const immediateActionId = id("anode");
    const delayId = id("anode");
    const afterDelayActionId = id("anode");
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId,
        name: "Fan-out with a waiting sibling",
        createdBy: userId,
        nodes: [
          { id: triggerId, type: "trigger_event", config: { eventType: "issue.transitioned" }, position: { x: 0, y: 0 } },
          { id: immediateActionId, type: "action_add_label", config: { label: "immediate" }, position: { x: 200, y: -50 } },
          { id: delayId, type: "delay", config: { amount: 5, unit: "minutes" }, position: { x: 200, y: 50 } },
          { id: afterDelayActionId, type: "action_comment", config: { text: "after the delay" }, position: { x: 400, y: 50 } },
        ],
        edges: [
          { fromNodeId: triggerId, toNodeId: immediateActionId },
          { fromNodeId: triggerId, toNodeId: delayId },
          { fromNodeId: delayId, toNodeId: afterDelayActionId },
        ],
      }),
    );

    await withAuthorizedTenant(ctx, (tx) => moveIssue(tx, { issueId, toStatusId: statuses[2]!.id, actorId: userId }));
    const event = await latestWorkflowEventFor(issueId, "issue.transitioned");
    await withAuthorizedTenant(ctx, (tx) => matchAndStartRuns(tx, event));
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowId));

    // Advancing the trigger cascades into both fan-out siblings: the
    // immediate action applies right away, while the delay sibling ends up
    // "waiting". Before the Finding-1 fix, the immediate sibling finishing
    // first (with the delay sibling's row not yet inserted) caused
    // finalizeRunIfDone to see zero active steps and prematurely mark the
    // run "completed" even though the delay step is genuinely still active.
    const [triggerStep] = await admin.select().from(schema.automationWorkflowRunStep).where(eq(schema.automationWorkflowRunStep.runId, run!.id));
    await withAuthorizedTenant(ctx, (tx) => advanceWorkflowStep(tx, triggerStep!));

    const stepsAfterFirstPass = await admin.select().from(schema.automationWorkflowRunStep).where(eq(schema.automationWorkflowRunStep.runId, run!.id));
    expect(stepsAfterFirstPass).toHaveLength(3); // trigger + immediate action + delay (afterDelayAction not created yet)
    const delayStep = stepsAfterFirstPass.find((s) => s.nodeId === delayId)!;
    expect(delayStep.status).toBe("waiting");
    expect(delayStep.resumeAt).not.toBeNull();

    const [issueMidRun] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issueMidRun?.labels).toEqual(["immediate"]); // the immediate sibling really did apply already

    const [runMidRun] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, run!.id));
    expect(runMidRun!.status).toBe("running"); // NOT prematurely "completed" while the delay sibling is still waiting

    // Force the delay due, resume it exactly like the worker's poll loop would.
    await admin.update(schema.automationWorkflowRunStep).set({ resumeAt: new Date(Date.now() - 1000) }).where(eq(schema.automationWorkflowRunStep.id, delayStep.id));
    const claimed = await claimDueWorkflowSteps(admin, 20);
    const ourClaimedDelayStep = claimed.find((s) => s.id === delayStep.id);
    expect(ourClaimedDelayStep).toBeTruthy();
    await withAuthorizedTenant(ctx, (tx) => advanceWorkflowStep(tx, ourClaimedDelayStep!));

    const finalSteps = await admin.select().from(schema.automationWorkflowRunStep).where(eq(schema.automationWorkflowRunStep.runId, run!.id));
    expect(finalSteps).toHaveLength(4);
    const comments = await admin.select().from(schema.issueComment).where(eq(schema.issueComment.issueId, issueId));
    expect(comments).toHaveLength(1);

    const [runFinal] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, run!.id));
    expect(runFinal!.status).toBe("completed");
  });
});
