import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, adminDb as admin } from "@kompast/db";
import { createProject } from "../project";
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

describe("automation workflow CRUD", () => {
  const orgId = "test-wf-org";
  const userId = "test-wf-user";
  const teamId = "test-wf-team";
  const ctx = { userId, organizationId: orgId };

  async function cleanup() {
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
});
