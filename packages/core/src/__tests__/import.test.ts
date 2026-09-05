import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { createImportRun, markImportRunRunning, completeImportRun, failImportRun, getImportRun, listImportRuns, resolveExternalRef, upsertExternalRef } from "../import";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("packages/core/import", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-import-org";
  const userId = "test-import-user";
  const teamId = "test-import-team";
  const ctx = { userId, organizationId: orgId };

  async function cleanup() {
    await admin.delete(schema.externalRef).where(eq(schema.externalRef.organizationId, orgId));
    await admin.delete(schema.importRun).where(eq(schema.importRun.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Import Test Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  async function seedProject() {
    return withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "imp", name: "Import Test", actorUserId: userId }));
  }

  it("runs the import_run lifecycle: pending -> running -> completed, with counts/errors recorded", async () => {
    const { projectId } = await seedProject();

    const { importRunId } = await withAuthorizedTenant(ctx, (tx) =>
      createImportRun(tx, { organizationId: orgId, projectId, source: "jira", dryRun: false, config: { baseUrl: "https://x.atlassian.net" }, createdBy: userId }),
    );
    let run = await withAuthorizedTenant(ctx, (tx) => getImportRun(tx, importRunId));
    expect(run?.status).toBe("pending");

    await withAuthorizedTenant(ctx, (tx) => markImportRunRunning(tx, importRunId));
    run = await withAuthorizedTenant(ctx, (tx) => getImportRun(tx, importRunId));
    expect(run?.status).toBe("running");
    expect(run?.startedAt).toBeInstanceOf(Date);

    await withAuthorizedTenant(ctx, (tx) => completeImportRun(tx, importRunId, { issuesCreated: 5 }, []));
    run = await withAuthorizedTenant(ctx, (tx) => getImportRun(tx, importRunId));
    expect(run?.status).toBe("completed");
    expect(run?.counts).toEqual({ issuesCreated: 5 });
    expect(run?.completedAt).toBeInstanceOf(Date);

    const runs = await withAuthorizedTenant(ctx, (tx) => listImportRuns(tx, projectId));
    expect(runs.map((r) => r.id)).toContain(importRunId);
  });

  it("failImportRun records the error and marks the run failed", async () => {
    const { projectId } = await seedProject();
    const { importRunId } = await withAuthorizedTenant(ctx, (tx) =>
      createImportRun(tx, { organizationId: orgId, projectId, source: "notion", dryRun: false, config: {}, createdBy: userId }),
    );

    await withAuthorizedTenant(ctx, (tx) => failImportRun(tx, importRunId, "rate limited by source API"));

    const run = await withAuthorizedTenant(ctx, (tx) => getImportRun(tx, importRunId));
    expect(run?.status).toBe("failed");
    expect(run?.errors).toEqual([{ error: "rate limited by source API" }]);
  });

  it("resolveExternalRef returns null for an unseen source id, then the ref after upsertExternalRef", async () => {
    const { projectId } = await seedProject();
    const { importRunId } = await withAuthorizedTenant(ctx, (tx) =>
      createImportRun(tx, { organizationId: orgId, projectId, source: "jira", dryRun: false, config: {}, createdBy: userId }),
    );

    expect(await withAuthorizedTenant(ctx, (tx) => resolveExternalRef(tx, orgId, "jira", "PROJ-1"))).toBeNull();

    await withAuthorizedTenant(ctx, (tx) =>
      upsertExternalRef(tx, { organizationId: orgId, source: "jira", sourceId: "PROJ-1", entityType: "issue", entityId: "issue_fake1", importRunId }),
    );

    const ref = await withAuthorizedTenant(ctx, (tx) => resolveExternalRef(tx, orgId, "jira", "PROJ-1"));
    expect(ref?.entityId).toBe("issue_fake1");
  });

  it("upsertExternalRef is idempotent — a second call for the same source id updates the entity, not a duplicate row", async () => {
    const { projectId } = await seedProject();
    const { importRunId } = await withAuthorizedTenant(ctx, (tx) =>
      createImportRun(tx, { organizationId: orgId, projectId, source: "jira", dryRun: false, config: {}, createdBy: userId }),
    );

    await withAuthorizedTenant(ctx, (tx) =>
      upsertExternalRef(tx, { organizationId: orgId, source: "jira", sourceId: "PROJ-2", entityType: "issue", entityId: "issue_first", importRunId }),
    );
    await withAuthorizedTenant(ctx, (tx) =>
      upsertExternalRef(tx, { organizationId: orgId, source: "jira", sourceId: "PROJ-2", entityType: "issue", entityId: "issue_first", importRunId }),
    );

    const allRefs = await admin.select().from(schema.externalRef).where(eq(schema.externalRef.organizationId, orgId));
    expect(allRefs.filter((r) => r.sourceId === "PROJ-2")).toHaveLength(1);
  });
});
