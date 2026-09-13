import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, adminDb as admin } from "@kompast/db";
import { createProject } from "../project";
import { createIssue } from "../issue";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("emitAutomationEvent", () => {
  const orgId = "test-aevents-org";
  const userId = "test-aevents-user";
  const teamId = "test-aevents-team";
  const ctx = { userId, organizationId: orgId };

  async function cleanup() {
    await admin.delete(schema.automationWorkflowEvent).where(eq(schema.automationWorkflowEvent.organizationId, orgId));
    await admin.delete(schema.automationWorkflow).where(eq(schema.automationWorkflow.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Aevents Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });
  });

  afterAll(cleanup);

  it("creating an issue writes a pending automation_workflow_event row", async () => {
    const { projectId, issueTypes, statuses } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: "aev", name: "Aevents Test", actorUserId: userId }),
    );
    const { issueId } = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Outbox issue", reporterId: userId }),
    );

    const [event] = await admin.select().from(schema.automationWorkflowEvent).where(eq(schema.automationWorkflowEvent.entityId, issueId));

    expect(event).toBeDefined();
    expect(event!.eventType).toBe("issue.created");
    expect(event!.depth).toBe(0);
    expect(event!.causedByWorkflowId).toBeNull();
    expect(event!.status).toBe("pending");
  });

  it("an automationContext with workflowId is recorded as causedByWorkflowId, at the given depth", async () => {
    const { projectId, issueTypes, statuses } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: "aev2", name: "Aevents Test 2", actorUserId: userId }),
    );
    const workflowId = "wf_fake123";
    await admin.insert(schema.automationWorkflow).values({
      id: workflowId,
      organizationId: orgId,
      projectId,
      name: "Test Workflow",
      createdBy: userId,
    });

    const { issueId } = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, {
        organizationId: orgId,
        projectId,
        typeId: issueTypes[0]!.id,
        statusId: statuses[0]!.id,
        title: "Caused-by-workflow issue",
        reporterId: userId,
        automationContext: { depth: 2, workflowId },
      }),
    );

    const [event] = await admin.select().from(schema.automationWorkflowEvent).where(eq(schema.automationWorkflowEvent.entityId, issueId));

    expect(event!.causedByWorkflowId).toBe(workflowId);
    expect(event!.depth).toBe(2);
  });
});
