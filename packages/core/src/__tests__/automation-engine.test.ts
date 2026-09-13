import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, and, adminDb as admin, withTenant } from "@kompast/db";
import { createProject } from "../project";
import { createIssue, moveIssue } from "../issue";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";
import { createWorkflow } from "../automation-workflow";
import {
  claimPendingWorkflowEvents,
  matchAndStartRuns,
  advanceWorkflowStep,
  claimDueWorkflowSteps,
  claimDueWorkflowSchedules,
  markWorkflowStepFailed,
} from "../automation-engine";
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
    // Ordered ascending by createdAt so `.at(-1)` deterministically means
    // the LATEST event — this is load-bearing for the self-trigger-loop
    // and fix-7 depth-propagation tests, which both assert on a SPECIFIC
    // (not just "some") event row. An unordered SELECT relies on
    // unspecified Postgres heap-scan row order.
    const rows = await admin
      .select()
      .from(schema.automationWorkflowEvent)
      .where(and(eq(schema.automationWorkflowEvent.entityId, issueId), eq(schema.automationWorkflowEvent.eventType, eventType)))
      .orderBy(schema.automationWorkflowEvent.createdAt);
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

  it("claimDueWorkflowSchedules fires a due schedule trigger and updates lastFiredAt", async () => {
    const { projectId } = await seedProjectAndIssue("eng");
    const triggerId = id("anode");
    const delayId = id("anode");
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId,
        name: "Daily digest",
        createdBy: userId,
        nodes: [
          { id: triggerId, type: "trigger_schedule", config: { cron: "* * * * *" }, position: { x: 0, y: 0 } }, // every minute — always "due" in a test
          // delay (not action_comment) downstream of a schedule trigger — a
          // schedule-triggered run's context has no issueId, and Fix 1's
          // save-time check now rejects any node downstream of
          // trigger_schedule other than action_webhook/delay. This test
          // never advances past the trigger step anyway (it only exercises
          // claimDueWorkflowSchedules itself), so the downstream node's
          // type doesn't otherwise matter here.
          { id: delayId, type: "delay", config: { amount: 5, unit: "minutes" }, position: { x: 200, y: 0 } },
        ],
        edges: [{ fromNodeId: triggerId, toNodeId: delayId }],
      }),
    );

    await withAuthorizedTenant(ctx, (tx) => claimDueWorkflowSchedules(tx, orgId));

    const runs = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowId));
    expect(runs).toHaveLength(1);
    const [node] = await admin.select().from(schema.automationNode).where(eq(schema.automationNode.id, triggerId));
    expect(node!.lastFiredAt).not.toBeNull();

    // Calling it again immediately must NOT double-fire — the schedule isn't due again for another minute.
    await withAuthorizedTenant(ctx, (tx) => claimDueWorkflowSchedules(tx, orgId));
    const runsAfter = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowId));
    expect(runsAfter).toHaveLength(1);
  });

  it("claimDueWorkflowSchedules is scoped to the given organizationId even over an RLS-bypassing admin connection (Fix 2)", async () => {
    const { projectId: projectAId } = await seedProjectAndIssue("enha");
    const triggerAId = id("anode");
    const { workflowId: workflowAId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId: projectAId,
        name: "Org A schedule",
        createdBy: userId,
        nodes: [{ id: triggerAId, type: "trigger_schedule", config: { cron: "* * * * *" }, position: { x: 0, y: 0 } }],
        edges: [],
      }),
    );

    // A second, fully independent organization — seeded directly rather
    // than via this file's shared ctx/orgId fixtures.
    const orgId2 = "test-engine-org-b";
    const userId2 = "test-engine-user-b";
    const teamId2 = "test-engine-team-b";
    await admin.insert(schema.organization).values({ id: orgId2, name: "Engine Org B", slug: orgId2 });
    await admin.insert(schema.user).values({ id: userId2, name: "User B", email: `${userId2}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId2, userId: userId2, role: "member" });
    await admin.insert(schema.team).values({ id: teamId2, organizationId: orgId2, name: "Test Team B" });
    const ctx2 = { userId: userId2, organizationId: orgId2 };
    const { projectId: projectBId } = await withAuthorizedTenant(ctx2, (tx) =>
      createProject(tx, { organizationId: orgId2, teamId: teamId2, key: "enhb", name: "enhb", actorUserId: userId2 }),
    );
    const triggerBId = id("anode");
    const { workflowId: workflowBId } = await withAuthorizedTenant(ctx2, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId2,
        projectId: projectBId,
        name: "Org B schedule",
        createdBy: userId2,
        nodes: [{ id: triggerBId, type: "trigger_schedule", config: { cron: "* * * * *" }, position: { x: 0, y: 0 } }],
        edges: [],
      }),
    );

    try {
      // Simulates production exactly: an admin (RLS-bypassing) connection,
      // scoped ONLY by the explicit organizationId argument — see
      // apps/worker's processWorkflowSchedules. Before Fix 2 there was no
      // organizationId filter at all, so this single call would have fired
      // BOTH orgs' due schedules.
      await withTenant(admin, { organizationId: orgId, userId: "system" }, (tx) => claimDueWorkflowSchedules(tx, orgId));

      const runsA = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowAId));
      const runsB = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowBId));
      expect(runsA).toHaveLength(1);
      expect(runsB).toHaveLength(0);
    } finally {
      await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId2));
      await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId2));
      await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId2));
      await admin.delete(schema.user).where(eq(schema.user.id, userId2));
      await admin.delete(schema.organization).where(eq(schema.organization.id, orgId2));
    }
  });

  it("markWorkflowStepFailed marks the step failed and finalizes the run's status (not left stuck at 'running') (Fix 6)", async () => {
    const { projectId, issueId } = await seedProjectAndIssue("enk");
    const triggerId = id("anode");
    const actionId = id("anode");
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId,
        name: "Failed step finalization test",
        createdBy: userId,
        nodes: [
          { id: triggerId, type: "trigger_event", config: { eventType: "issue.transitioned" }, position: { x: 0, y: 0 } },
          { id: actionId, type: "action_add_label", config: { label: "x" }, position: { x: 200, y: 0 } },
        ],
        edges: [{ fromNodeId: triggerId, toNodeId: actionId }],
      }),
    );
    const runId = id("wfrun");
    await admin.insert(schema.automationWorkflowRun).values({ id: runId, organizationId: orgId, workflowId, context: { issueId } });
    const stepId = id("wfstep");
    await admin.insert(schema.automationWorkflowRunStep).values({ id: stepId, runId, nodeId: actionId, depth: 0, status: "processing" });

    await withAuthorizedTenant(ctx, (tx) => markWorkflowStepFailed(tx, { id: stepId, runId }, "simulated unexpected worker crash"));

    const [step] = await admin.select().from(schema.automationWorkflowRunStep).where(eq(schema.automationWorkflowRunStep.id, stepId));
    expect(step!.status).toBe("failed");
    expect(step!.error).toBe("simulated unexpected worker crash");

    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    expect(run!.status).toBe("failed"); // NOT left stuck at "running"
  });

  it("condition_switch fans out to only the matching case's branch, not the others", async () => {
    const { projectId, issueId, statuses } = await seedProjectAndIssue("enswitch");
    void statuses;
    const triggerId = id("anode");
    const switchId = id("anode");
    const highActionId = id("anode");
    const lowActionId = id("anode");
    const defaultActionId = id("anode");
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId,
        name: "Switch fan-out test",
        createdBy: userId,
        nodes: [
          { id: triggerId, type: "trigger_event", config: { eventType: "issue.created" }, position: { x: 0, y: 0 } },
          { id: switchId, type: "condition_switch", config: { property: "priority", cases: ["high", "low"] }, position: { x: 200, y: 0 } },
          { id: highActionId, type: "action_add_label", config: { label: "was-high" }, position: { x: 400, y: -100 } },
          { id: lowActionId, type: "action_add_label", config: { label: "was-low" }, position: { x: 400, y: 0 } },
          { id: defaultActionId, type: "action_add_label", config: { label: "was-default" }, position: { x: 400, y: 100 } },
        ],
        edges: [
          { fromNodeId: triggerId, toNodeId: switchId },
          { fromNodeId: switchId, fromHandle: "high", toNodeId: highActionId },
          { fromNodeId: switchId, fromHandle: "low", toNodeId: lowActionId },
          { fromNodeId: switchId, fromHandle: "default", toNodeId: defaultActionId },
        ],
      }),
    );

    const event = await latestWorkflowEventFor(issueId, "issue.created");
    await withAuthorizedTenant(ctx, (tx) => matchAndStartRuns(tx, event));
    const runs = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowId));
    await runAllSteps(runs[0]!.id);

    // Default seeded issue priority is "medium" — matches neither "high" nor "low", so only the "default" branch fires.
    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.labels).toEqual(["was-default"]);
  });

  it("loop_each fans out one child step per (item x edge), applying the downstream action once per item", async () => {
    const { projectId, issueId } = await seedProjectAndIssue("enloop");
    const triggerId = id("anode");
    const loopId = id("anode");
    const actionId = id("anode");
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId,
        name: "Loop fan-out test",
        createdBy: userId,
        nodes: [
          { id: triggerId, type: "trigger_event", config: { eventType: "issue.created" }, position: { x: 0, y: 0 } },
          { id: loopId, type: "loop_each", config: { source: "{{trigger.payload.labels}}", itemType: "value" }, position: { x: 200, y: 0 } },
          { id: actionId, type: "action_add_label", config: { label: "{{item}}" }, position: { x: 400, y: 0 } },
        ],
        edges: [
          { fromNodeId: triggerId, toNodeId: loopId },
          { fromNodeId: loopId, toNodeId: actionId },
        ],
      }),
    );

    const event = await latestWorkflowEventFor(issueId, "issue.created");
    // The real issue.created payload has no "labels" array to loop over — override the outbox row's payload directly for this test's purposes.
    await admin.update(schema.automationWorkflowEvent).set({ payload: { ...(event.payload as object), labels: ["alpha", "beta", "gamma"] } }).where(eq(schema.automationWorkflowEvent.id, event.id));
    const [updatedEvent] = await admin.select().from(schema.automationWorkflowEvent).where(eq(schema.automationWorkflowEvent.id, event.id));
    await withAuthorizedTenant(ctx, (tx) => matchAndStartRuns(tx, updatedEvent!));
    const runs = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowId));
    await runAllSteps(runs[0]!.id);

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(new Set(issue?.labels)).toEqual(new Set(["alpha", "beta", "gamma"]));

    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runs[0]!.id));
    expect(run!.status).toBe("completed");
  });

  it("end-to-end: a schedule trigger finds issues, loops over them, and labels each one — the combined feature this engine was built for", async () => {
    const { projectId, statuses, issueTypes } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: "enssched", name: "enssched", actorUserId: userId }),
    );
    const { issueId: matchingIssue1 } = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Matches", reporterId: userId }),
    );
    const { issueId: matchingIssue2 } = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Also matches", reporterId: userId }),
    );
    const { issueId: nonMatchingIssue } = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[1]!.id, title: "Does not match", reporterId: userId }),
    );

    const triggerId = id("anode");
    const findId = id("anode");
    const loopId = id("anode");
    const actionId = id("anode");
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId,
        name: "Nightly label sweep",
        createdBy: userId,
        nodes: [
          { id: triggerId, type: "trigger_schedule", config: { cron: "0 9 * * *" }, position: { x: 0, y: 0 } },
          { id: findId, type: "find_issues", config: { statusId: statuses[0]!.id }, name: "find", position: { x: 200, y: 0 } },
          { id: loopId, type: "loop_each", config: { source: "{{steps.find.output.issueIds}}", itemType: "issueId" }, position: { x: 400, y: 0 } },
          { id: actionId, type: "action_add_label", config: { label: "nightly" }, position: { x: 600, y: 0 } },
        ],
        edges: [
          { fromNodeId: triggerId, toNodeId: findId },
          { fromNodeId: findId, toNodeId: loopId },
          { fromNodeId: loopId, toNodeId: actionId },
        ],
      }),
    );

    await withTenant(admin, { organizationId: orgId, userId: "system" }, (tx) => claimDueWorkflowSchedules(tx, orgId));
    const runs = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowId));
    expect(runs).toHaveLength(1);
    await runAllSteps(runs[0]!.id);

    const [issue1] = await admin.select().from(schema.issue).where(eq(schema.issue.id, matchingIssue1));
    const [issue2] = await admin.select().from(schema.issue).where(eq(schema.issue.id, matchingIssue2));
    const [issue3] = await admin.select().from(schema.issue).where(eq(schema.issue.id, nonMatchingIssue));
    expect(issue1?.labels).toContain("nightly");
    expect(issue2?.labels).toContain("nightly");
    expect(issue3?.labels ?? []).not.toContain("nightly");

    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runs[0]!.id));
    expect(run!.status).toBe("completed");
  });
});
