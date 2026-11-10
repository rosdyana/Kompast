import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, and, adminDb as admin } from "@kompast/db";
import { createProject } from "../project";
import { createIssue, moveIssue } from "../issue";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  setWorkflowEnabled,
  updateWorkflow,
  type AutomationNodeInput,
} from "../automation-workflow";
import { matchAndStartRuns, advanceWorkflowStep, claimDueWorkflowSchedules } from "../automation-engine";

describe("automation workflow CRUD", () => {
  const orgId = "test-wf-org";
  const userId = "test-wf-user";
  const teamId = "test-wf-team";
  const ctx = { userId, organizationId: orgId };

  async function cleanup() {
    await admin.delete(schema.automationWorkflowEvent).where(eq(schema.automationWorkflowEvent.organizationId, orgId));
    await admin.delete(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Workflow Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });
    // The fixture user must belong to the team that owns the project, or
    // team-scoped RLS (packages/db/rls.sql) hides it from them.
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });
  });

  afterAll(cleanup);

  async function seedProject(key: string) {
    const { projectId } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key, name: key, actorUserId: userId }),
    );
    return projectId;
  }

  function twoNodeGraph() {
    const triggerId = id("anode");
    const actionId = id("anode");
    // Explicitly typed (rather than relying on `as const` inference) — a
    // union of these two node shapes assigned straight into `Json`'s
    // indexed-object variant otherwise trips a TS quirk where checking a
    // union against a type with a string index signature synthesizes
    // `label?: undefined`/`eventType?: undefined` cross-members and rejects
    // it; annotating the array sidesteps that without changing runtime shape.
    const nodes: AutomationNodeInput[] = [
      { id: triggerId, type: "trigger_event", config: { eventType: "issue.transitioned" }, position: { x: 0, y: 0 } },
      { id: actionId, type: "action_add_label", config: { label: "auto" }, position: { x: 200, y: 0 } },
    ];
    return {
      nodes,
      edges: [{ fromNodeId: triggerId, toNodeId: actionId }],
      triggerId,
      actionId,
    };
  }

  it("creates a workflow with its nodes and edges, and reads it back", async () => {
    const projectId = await seedProject("wfa");
    const { nodes, edges } = twoNodeGraph();
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, { organizationId: orgId, projectId, name: "Label on transition", createdBy: userId, nodes, edges }),
    );

    const workflow = await withAuthorizedTenant(ctx, (tx) => getWorkflow(tx, workflowId));
    expect(workflow!.name).toBe("Label on transition");
    expect(workflow!.enabled).toBe(true);
    expect(workflow!.nodes).toHaveLength(2);
    expect(workflow!.edges).toHaveLength(1);
    expect(workflow!.edges[0]!.fromNodeId).toBe(nodes[0]!.id);
    expect(workflow!.edges[0]!.toNodeId).toBe(nodes[1]!.id);
  });

  it("lists workflows for a project, newest first is not required but all belong to that project", async () => {
    const projectId = await seedProject("wfb");
    const graph1 = twoNodeGraph();
    const graph2 = twoNodeGraph();
    await withAuthorizedTenant(ctx, (tx) => createWorkflow(tx, { organizationId: orgId, projectId, name: "First", createdBy: userId, nodes: graph1.nodes, edges: graph1.edges }));
    await withAuthorizedTenant(ctx, (tx) => createWorkflow(tx, { organizationId: orgId, projectId, name: "Second", createdBy: userId, nodes: graph2.nodes, edges: graph2.edges }));

    const workflows = await withAuthorizedTenant(ctx, (tx) => listWorkflows(tx, projectId));
    expect(workflows).toHaveLength(2);
    expect(workflows.map((w) => w.name).sort()).toEqual(["First", "Second"]);
  });

  it("updateWorkflow full-replaces nodes/edges when given, and never orphans an edge", async () => {
    const projectId = await seedProject("wfc");
    const { nodes, edges } = twoNodeGraph();
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, { organizationId: orgId, projectId, name: "Original", createdBy: userId, nodes, edges }),
    );

    const replacement = twoNodeGraph();
    await withAuthorizedTenant(ctx, (tx) =>
      updateWorkflow(tx, { workflowId, projectId, name: "Renamed", nodes: replacement.nodes, edges: replacement.edges }),
    );

    const workflow = await withAuthorizedTenant(ctx, (tx) => getWorkflow(tx, workflowId));
    expect(workflow!.name).toBe("Renamed");
    expect(workflow!.nodes.map((n) => n.id).sort()).toEqual([replacement.nodes[0]!.id, replacement.nodes[1]!.id].sort());
    expect(workflow!.edges).toHaveLength(1);

    // The old nodes must be gone (cascade), not just unreferenced.
    const oldNodeRows = await admin.select().from(schema.automationNode).where(eq(schema.automationNode.id, nodes[0]!.id));
    expect(oldNodeRows).toHaveLength(0);
  });

  it("updateWorkflow with only enabled/dryRun leaves the graph untouched", async () => {
    const projectId = await seedProject("wfd");
    const { nodes, edges } = twoNodeGraph();
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, { organizationId: orgId, projectId, name: "Flag toggle", createdBy: userId, nodes, edges }),
    );

    await withAuthorizedTenant(ctx, (tx) => updateWorkflow(tx, { workflowId, projectId, dryRun: true }));

    const workflow = await withAuthorizedTenant(ctx, (tx) => getWorkflow(tx, workflowId));
    expect(workflow!.dryRun).toBe(true);
    expect(workflow!.nodes).toHaveLength(2);
  });

  it("setWorkflowEnabled toggles the flag", async () => {
    const projectId = await seedProject("wfe");
    const { nodes, edges } = twoNodeGraph();
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, { organizationId: orgId, projectId, name: "Toggle me", createdBy: userId, nodes, edges }),
    );

    await withAuthorizedTenant(ctx, (tx) => setWorkflowEnabled(tx, workflowId, false));
    const workflow = await withAuthorizedTenant(ctx, (tx) => getWorkflow(tx, workflowId));
    expect(workflow!.enabled).toBe(false);
  });

  it("deleteWorkflow cascades to its nodes and edges", async () => {
    const projectId = await seedProject("wff");
    const { nodes, edges } = twoNodeGraph();
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, { organizationId: orgId, projectId, name: "Delete me", createdBy: userId, nodes, edges }),
    );

    await withAuthorizedTenant(ctx, (tx) => deleteWorkflow(tx, workflowId));

    const workflow = await withAuthorizedTenant(ctx, (tx) => getWorkflow(tx, workflowId));
    expect(workflow).toBeNull();
    const nodeRows = await admin.select().from(schema.automationNode).where(eq(schema.automationNode.id, nodes[0]!.id));
    expect(nodeRows).toHaveLength(0);
  });

  it("rejects an edge referencing a node id that isn't in this graph", async () => {
    const projectId = await seedProject("wfg");
    const { nodes } = twoNodeGraph();

    await expect(
      withAuthorizedTenant(ctx, (tx) =>
        createWorkflow(tx, {
          organizationId: orgId,
          projectId,
          name: "Dangling edge",
          createdBy: userId,
          nodes,
          edges: [{ fromNodeId: nodes[0]!.id, toNodeId: "anode_does_not_exist" }],
        }),
      ),
    ).rejects.toThrow(/does not exist in this graph/);
  });

  it("rejects a non-trigger node with no path from any trigger", async () => {
    const projectId = await seedProject("wfh");
    const { nodes: triggerAndAction } = twoNodeGraph();
    const orphanId = id("anode");

    await expect(
      withAuthorizedTenant(ctx, (tx) =>
        createWorkflow(tx, {
          organizationId: orgId,
          projectId,
          name: "Orphan node",
          createdBy: userId,
          nodes: [...triggerAndAction, { id: orphanId, type: "action_add_label", config: { label: "orphan" }, position: { x: 0, y: 300 } }],
          edges: [{ fromNodeId: triggerAndAction[0]!.id, toNodeId: triggerAndAction[1]!.id }],
        }),
      ),
    ).rejects.toThrow(/not reachable from any trigger/);
  });

  it("accepts a trigger_schedule -> action_webhook graph (Fix 1)", async () => {
    const projectId = await seedProject("wfj");
    const triggerId = id("anode");
    const webhookId = id("anode");
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId,
        name: "Schedule webhook",
        createdBy: userId,
        nodes: [
          { id: triggerId, type: "trigger_schedule", config: { cron: "0 9 * * *" }, position: { x: 0, y: 0 } },
          { id: webhookId, type: "action_webhook", config: { url: "https://example.com", method: "POST", headers: {}, bodyTemplate: {} }, position: { x: 200, y: 0 } },
        ],
        edges: [{ fromNodeId: triggerId, toNodeId: webhookId }],
      }),
    );
    expect(workflowId).toBeTruthy();
  });

  it("rejects a trigger_schedule -> action_add_label graph — a schedule tick has no triggering issue (Fix 1)", async () => {
    const projectId = await seedProject("wfk");
    const triggerId = id("anode");
    const actionId = id("anode");

    await expect(
      withAuthorizedTenant(ctx, (tx) =>
        createWorkflow(tx, {
          organizationId: orgId,
          projectId,
          name: "Schedule with issue action",
          createdBy: userId,
          nodes: [
            { id: triggerId, type: "trigger_schedule", config: { cron: "0 9 * * *" }, position: { x: 0, y: 0 } },
            { id: actionId, type: "action_add_label", config: { label: "x" }, position: { x: 200, y: 0 } },
          ],
          edges: [{ fromNodeId: triggerId, toNodeId: actionId }],
        }),
      ),
    ).rejects.toThrow(/requires an issueId/);
  });

  it("accepts a trigger_schedule -> find_issues -> loop_each(issueId) -> action_add_label graph — the loop supplies the issueId", async () => {
    const projectId = await seedProject("wfk2");
    const triggerId = id("anode");
    const findId = id("anode");
    const loopId = id("anode");
    const actionId = id("anode");

    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, {
        organizationId: orgId,
        projectId,
        name: "Schedule over issues",
        createdBy: userId,
        nodes: [
          { id: triggerId, type: "trigger_schedule", config: { cron: "0 9 * * *" }, position: { x: 0, y: 0 } },
          { id: findId, type: "find_issues", config: {}, name: "find", position: { x: 200, y: 0 } },
          { id: loopId, type: "loop_each", config: { source: "{{steps.find.output.issueIds}}", itemType: "issueId" }, position: { x: 400, y: 0 } },
          { id: actionId, type: "action_add_label", config: { label: "x" }, position: { x: 600, y: 0 } },
        ],
        edges: [
          { fromNodeId: triggerId, toNodeId: findId },
          { fromNodeId: findId, toNodeId: loopId },
          { fromNodeId: loopId, toNodeId: actionId },
        ],
      }),
    );
    expect(workflowId).toBeTruthy();
  });

  it("rejects a trigger_schedule -> condition_property placed BEFORE any loop over issues — no issueId source yet at that point", async () => {
    const projectId = await seedProject("wfk3");
    const triggerId = id("anode");
    const conditionId = id("anode");

    await expect(
      withAuthorizedTenant(ctx, (tx) =>
        createWorkflow(tx, {
          organizationId: orgId,
          projectId,
          name: "Schedule with early condition",
          createdBy: userId,
          nodes: [
            { id: triggerId, type: "trigger_schedule", config: { cron: "0 9 * * *" }, position: { x: 0, y: 0 } },
            { id: conditionId, type: "condition_property", config: { property: "priority", operator: "eq", value: "high" }, position: { x: 200, y: 0 } },
          ],
          edges: [{ fromNodeId: triggerId, toNodeId: conditionId }],
        }),
      ),
    ).rejects.toThrow(/requires an issueId/);
  });

  it("rejects a malformed cron expression on a schedule trigger at save time (Fix 2)", async () => {
    const projectId = await seedProject("wfl");
    const triggerId = id("anode");

    await expect(
      withAuthorizedTenant(ctx, (tx) =>
        createWorkflow(tx, {
          organizationId: orgId,
          projectId,
          name: "Bad cron",
          createdBy: userId,
          nodes: [{ id: triggerId, type: "trigger_schedule", config: { cron: "not a cron expression" }, position: { x: 0, y: 0 } }],
          edges: [],
        }),
      ),
    ).rejects.toThrow(/Invalid cron expression/);
  });

  async function seedProjectAndIssue(key: string) {
    const { projectId, issueTypes, statuses } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key, name: key, actorUserId: userId }),
    );
    const { issueId } = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Workflow test issue", reporterId: userId }),
    );
    return { projectId, issueId, statuses };
  }

  async function latestWorkflowEventFor(issueId: string, eventType: string) {
    const rows = await admin
      .select()
      .from(schema.automationWorkflowEvent)
      .where(and(eq(schema.automationWorkflowEvent.entityId, issueId), eq(schema.automationWorkflowEvent.eventType, eventType)))
      .orderBy(schema.automationWorkflowEvent.createdAt);
    return rows.at(-1)!;
  }

  it("updateWorkflow with the same node ids keeps run-step history", async () => {
    const projectId = await seedProject("wfm");
    const { nodes, edges, triggerId, actionId } = twoNodeGraph();
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, { organizationId: orgId, projectId, name: "Keeps history", createdBy: userId, nodes, edges }),
    );

    const runId = id("wfrun");
    await admin.insert(schema.automationWorkflowRun).values({ id: runId, organizationId: orgId, workflowId, context: {}, status: "completed" });
    await admin.insert(schema.automationWorkflowRunStep).values([
      { id: id("wfstep"), runId, nodeId: triggerId, depth: 0, status: "succeeded" },
      { id: id("wfstep"), runId, nodeId: actionId, depth: 1, status: "succeeded" },
    ]);

    const changed: AutomationNodeInput[] = [nodes[0]!, { ...nodes[1]!, config: { label: "changed" }, position: { x: 300, y: 100 } }];
    await withAuthorizedTenant(ctx, (tx) => updateWorkflow(tx, { workflowId, projectId, nodes: changed, edges }));

    const steps = await admin.select().from(schema.automationWorkflowRunStep).where(eq(schema.automationWorkflowRunStep.runId, runId));
    expect(steps).toHaveLength(2);

    const [actionRow] = await admin.select().from(schema.automationNode).where(eq(schema.automationNode.id, actionId));
    expect(actionRow!.config).toEqual({ label: "changed" });
    expect(actionRow!.position).toEqual({ x: 300, y: 100 });

    const workflow = await withAuthorizedTenant(ctx, (tx) => getWorkflow(tx, workflowId));
    expect(workflow!.nodes).toHaveLength(2);
    expect(workflow!.edges).toHaveLength(1);
  });

  it("updateWorkflow keeps a schedule trigger's lastFiredAt, so a save doesn't re-fire it", async () => {
    const projectId = await seedProject("wfn");
    const triggerId = id("anode");
    const delayId = id("anode");
    const nodes: AutomationNodeInput[] = [
      { id: triggerId, type: "trigger_schedule", config: { cron: "0 0 1 1 *" }, position: { x: 0, y: 0 } }, // once a year — never naturally due again during this test
      { id: delayId, type: "delay", config: { amount: 5, unit: "minutes" }, position: { x: 200, y: 0 } },
    ];
    const edges = [{ fromNodeId: triggerId, toNodeId: delayId }];
    const { workflowId } = await withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, { organizationId: orgId, projectId, name: "Yearly", createdBy: userId, nodes, edges }),
    );

    await withAuthorizedTenant(ctx, (tx) => claimDueWorkflowSchedules(tx, orgId));
    const runsAfterFirstClaim = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowId));
    expect(runsAfterFirstClaim).toHaveLength(1);
    const [triggerAfterFirstClaim] = await admin.select().from(schema.automationNode).where(eq(schema.automationNode.id, triggerId));
    expect(triggerAfterFirstClaim!.lastFiredAt).not.toBeNull();
    const firedAt = triggerAfterFirstClaim!.lastFiredAt;

    await withAuthorizedTenant(ctx, (tx) => updateWorkflow(tx, { workflowId, projectId, name: "Renamed", nodes, edges }));

    const [triggerAfterSave] = await admin.select().from(schema.automationNode).where(eq(schema.automationNode.id, triggerId));
    expect(triggerAfterSave!.lastFiredAt).toEqual(firedAt);

    await withAuthorizedTenant(ctx, (tx) => claimDueWorkflowSchedules(tx, orgId));
    const runsAfterSecondClaim = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.workflowId, workflowId));
    expect(runsAfterSecondClaim).toHaveLength(1);
  });

  it("removing a node finalizes a run that was waiting on it", async () => {
    const { projectId, issueId, statuses } = await seedProjectAndIssue("wfo");
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
    const [triggerStep] = await admin.select().from(schema.automationWorkflowRunStep).where(eq(schema.automationWorkflowRunStep.runId, run!.id));
    await withAuthorizedTenant(ctx, (tx) => advanceWorkflowStep(tx, triggerStep!));

    const [runWaiting] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, run!.id));
    expect(runWaiting!.status).toBe("running");
    const stepsWaiting = await admin.select().from(schema.automationWorkflowRunStep).where(eq(schema.automationWorkflowRunStep.runId, run!.id));
    expect(stepsWaiting.find((s) => s.nodeId === delayId)!.status).toBe("waiting");

    // Save the graph with the delay node and the after-delay node removed.
    await withAuthorizedTenant(ctx, (tx) =>
      updateWorkflow(tx, {
        workflowId,
        projectId,
        nodes: [
          { id: triggerId, type: "trigger_event", config: { eventType: "issue.transitioned" }, position: { x: 0, y: 0 } },
          { id: immediateActionId, type: "action_add_label", config: { label: "immediate" }, position: { x: 200, y: -50 } },
        ],
        edges: [{ fromNodeId: triggerId, toNodeId: immediateActionId }],
      }),
    );

    const [runAfterSave] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, run!.id));
    expect(runAfterSave!.status).toBe("completed");
    const stepsAfterSave = await admin.select().from(schema.automationWorkflowRunStep).where(eq(schema.automationWorkflowRunStep.runId, run!.id));
    const remainingNodeIds = stepsAfterSave.map((s) => s.nodeId).sort();
    expect(remainingNodeIds).toEqual([triggerId, immediateActionId].sort());
  });
});
