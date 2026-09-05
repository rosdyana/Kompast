import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { resolveLocalPath } from "@kompast/storage";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createProject } from "../project";
import { createIssue } from "../issue";
import { requestAttachmentUpload, listAttachments, deleteAttachment, attachIssueFile } from "../attachment";
import { readFileSync } from "node:fs";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

/**
 * Uses the real local storage driver (STORAGE_DRIVER=local in
 * .env.local.dev) — requestAttachmentUpload really calls getUploadUrl,
 * listAttachments really calls getDownloadUrl, and this test writes bytes
 * to the exact path those URLs encode to prove the whole key scheme is
 * consistent end-to-end, not just that each half compiles.
 *
 * Fixture setup/teardown uses an admin-connected client, not the app-role
 * `db` — project/issue* tables are RLS-protected, so a plain `db.delete`
 * here (no workspace GUC set) would silently match zero rows rather than
 * error, leaving rows behind (this bit an earlier draft of this file: the
 * user delete then failed on a still-referenced project.lead_id FK, not
 * because of a real product bug, but because RLS silently no-opped the
 * project cleanup).
 */
describe("attachments", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-attach-org";
  const userId = "test-attach-user";
  const teamId = "test-attach-team";
  let projectKeyCounter = 0;

  beforeEach(async () => {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.userId, userId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));

    await admin.insert(schema.organization).values({ id: orgId, name: "Test Attach Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "Test User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });
  });

  afterAll(async () => {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.userId, userId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await adminClient.end();
  });

  async function seedIssue() {
    projectKeyCounter += 1;
    return withAuthorizedTenant({ userId, organizationId: orgId }, async (tx) => {
      const { projectId, issueTypes, statuses } = await createProject(tx, {
        organizationId: orgId,
        teamId,
        key: `att${projectKeyCounter}`,
        name: "Attach",
        actorUserId: userId,
      });
      const { issueId } = await createIssue(tx, {
        organizationId: orgId,
        projectId,
        typeId: issueTypes[0]!.id,
        statusId: statuses[0]!.id,
        title: "Test issue",
        reporterId: userId,
      });
      return issueId;
    });
  }

  it("issues an upload URL, and the key it encodes resolves to a real, writable local path", async () => {
    const issueId = await seedIssue();

    const { attachmentId, uploadUrl } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      requestAttachmentUpload(tx, {
        issueId,
        uploaderId: userId,
        fileName: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 1234,
      }),
    );

    const [row] = await admin.select().from(schema.issueAttachment).where(eq(schema.issueAttachment.id, attachmentId));
    expect(row?.fileName).toBe("report.pdf");

    // Simulate the browser's PUT: write real bytes to the exact path the
    // signed upload URL's key resolves to.
    const path = resolveLocalPath(row!.storageKey);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fake-pdf-bytes");
    expect(existsSync(path)).toBe(true);
    expect(uploadUrl).toContain("/api/storage/upload/");

    const attachments = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => listAttachments(tx, issueId));
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.downloadUrl).toContain("/api/storage/download/");
  });

  it("deleteAttachment removes both the DB row and the real file from disk", async () => {
    const issueId = await seedIssue();
    const { attachmentId } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      requestAttachmentUpload(tx, {
        issueId,
        uploaderId: userId,
        fileName: "delete-me.txt",
        contentType: "text/plain",
        sizeBytes: 5,
      }),
    );
    const [row] = await admin.select().from(schema.issueAttachment).where(eq(schema.issueAttachment.id, attachmentId));
    const path = resolveLocalPath(row!.storageKey);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "hello");

    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      deleteAttachment(tx, { attachmentId, issueId }),
    );

    expect(existsSync(path)).toBe(false);
    const remaining = await admin
      .select()
      .from(schema.issueAttachment)
      .where(eq(schema.issueAttachment.id, attachmentId));
    expect(remaining).toHaveLength(0);
  });

  it("rejects deleting an attachment that belongs to a different issue", async () => {
    const issueId = await seedIssue();
    const otherIssueId = await seedIssue();
    const { attachmentId } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      requestAttachmentUpload(tx, {
        issueId,
        uploaderId: userId,
        fileName: "mine.txt",
        contentType: "text/plain",
        sizeBytes: 5,
      }),
    );

    await expect(
      withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
        deleteAttachment(tx, { attachmentId, issueId: otherIssueId }),
      ),
    ).rejects.toThrow(/not found/);
  });

  it("attachIssueFile (the importer's server-side path) writes real bytes directly, with no browser round-trip", async () => {
    const issueId = await seedIssue();
    const bytes = Buffer.from("real JIRA attachment bytes, fetched server-side");

    const { attachmentId } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      attachIssueFile(tx, { issueId, uploaderId: userId, fileName: "from-jira.png", contentType: "image/png", data: bytes }),
    );

    const [row] = await admin.select().from(schema.issueAttachment).where(eq(schema.issueAttachment.id, attachmentId));
    expect(row?.fileName).toBe("from-jira.png");
    expect(row?.sizeBytes).toBe(bytes.byteLength);

    const path = resolveLocalPath(row!.storageKey);
    expect(readFileSync(path)).toEqual(bytes);
  });
});
