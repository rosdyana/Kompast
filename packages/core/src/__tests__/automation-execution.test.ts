import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, adminDb as admin } from "@kompast/db";
import { createProject } from "../project";
import { createIssue } from "../issue";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";
import { toPlainText } from "../rich-text";
import { executeNode } from "../automation-execution";

describe("automation-execution: executeNode", () => {
  const orgId = "test-exec-org";
  const userId = "test-exec-user";
  const teamId = "test-exec-team";
  const ctx = { userId, organizationId: orgId };

  async function cleanup() {
    await admin.delete(schema.automationWorkflowRunStep).where(eq(schema.automationWorkflowRunStep.runId, "___never_matches___")); // no-op; steps cascade from runs
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
    await admin.insert(schema.organization).values({ id: orgId, name: "Exec Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });
  });

  afterAll(cleanup);

  async function seedProjectIssueAndWorkflow(key: string) {
    const { projectId, issueTypes, statuses } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key, name: key, actorUserId: userId }),
    );
    const { issueId } = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Exec test issue", reporterId: userId }),
    );
    const workflowId = id("wf");
    await admin.insert(schema.automationWorkflow).values({ id: workflowId, organizationId: orgId, projectId, name: "Exec test workflow", createdBy: userId });
    const runId = id("wfrun");
    await admin.insert(schema.automationWorkflowRun).values({ id: runId, organizationId: orgId, workflowId, context: { issueId } });
    return { projectId, issueId, statuses, workflowId, runId };
  }

  function fakeNode(type: string, config: Record<string, unknown>) {
    return { id: id("anode"), workflowId: "unused", type, config, position: { x: 0, y: 0 } } as never;
  }

  it("condition_property: eq match on a core field routes to the true branch", async () => {
    const { issueId, runId, workflowId } = await seedProjectIssueAndWorkflow("exa");
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("condition_property", { property: "priority", operator: "eq", value: "medium" });
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!));

    expect(result.status).toBe("succeeded");
    expect(result.branchTaken).toBe("true"); // default issue priority is "medium"
    void issueId;
  });

  it("condition_property: no match routes to the false branch", async () => {
    const { runId, workflowId } = await seedProjectIssueAndWorkflow("exb");
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("condition_property", { property: "priority", operator: "eq", value: "highest" });
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!));

    expect(result.branchTaken).toBe("false");
  });

  it("action_set_property on status calls moveIssue (records a transition, not a generic update)", async () => {
    const { issueId, statuses, runId, workflowId } = await seedProjectIssueAndWorkflow("exc");
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("action_set_property", { property: "status", value: statuses[2]!.id });
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!));

    expect(result.status).toBe("succeeded");
    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.statusId).toBe(statuses[2]!.id);
    const history = await admin.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, issueId));
    expect(history.some((h) => h.field === "status")).toBe(true);
  });

  it("action_set_property on assigneeId calls updateIssue", async () => {
    const { issueId, runId, workflowId } = await seedProjectIssueAndWorkflow("exd");
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("action_set_property", { property: "assigneeId", value: userId });
    await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!));

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.assigneeId).toBe(userId);
  });

  it("action_set_property on a custom field key merges into customFields", async () => {
    const { issueId, projectId, runId, workflowId } = await seedProjectIssueAndWorkflow("exe");
    await withAuthorizedTenant(ctx, (tx) =>
      tx.insert(schema.issuePropertyDefinition).values({ id: id("iprop"), projectId, key: "region", name: "Region", type: "text", order: 100 }),
    );
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("action_set_property", { property: "region", value: "APAC" });
    await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!));

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.customFields).toMatchObject({ region: "APAC" });
  });

  it("action_add_label appends without duplicating", async () => {
    const { issueId, runId, workflowId } = await seedProjectIssueAndWorkflow("exf");
    await admin.update(schema.issue).set({ labels: ["existing"] }).where(eq(schema.issue.id, issueId));
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("action_add_label", { label: "existing" });
    await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!));

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.labels).toEqual(["existing"]);
  });

  it("action_comment writes a real comment", async () => {
    const { issueId, runId, workflowId } = await seedProjectIssueAndWorkflow("exg");
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("action_comment", { text: "Handled by a workflow" });
    await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!));

    const comments = await admin.select().from(schema.issueComment).where(eq(schema.issueComment.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(toPlainText(comments[0]!.bodyJson)).toBe("Handled by a workflow");
  });

  it("delay sets status to waiting with a future resumeAt and does not mutate the issue", async () => {
    const { issueId, runId, workflowId } = await seedProjectIssueAndWorkflow("exh");
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const before = Date.now();
    const node = fakeNode("delay", { amount: 30, unit: "minutes" });
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!));

    expect(result.status).toBe("waiting");
    expect(result.resumeAt!.getTime()).toBeGreaterThan(before + 29 * 60 * 1000);
    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.updatedAt.getTime()).toBeLessThanOrEqual(before + 1000);
  });

  it("dry-run workflow computes the action but never applies it", async () => {
    const { issueId, runId, workflowId } = await seedProjectIssueAndWorkflow("exi");
    await admin.update(schema.automationWorkflow).set({ dryRun: true }).where(eq(schema.automationWorkflow.id, workflowId));
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("action_add_label", { label: "would-be-added" });
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!));

    expect(result.status).toBe("succeeded");
    expect(result.output).toMatchObject({ dryRun: true });
    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.labels).toEqual([]);
  });
});
