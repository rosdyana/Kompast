import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, eq, inArray, adminDb as admin } from "@kompast/db";
import { createIssue, createProject, withAuthorizedTenant } from "@kompast/core";
import { id } from "@kompast/core/ids";
import { getAuth } from "../../../lib/auth";
import { Route } from "../issue-attachments.$attachmentId";

// The route redirects a stored file to a storage URL; keep that to a fixed, visible string.
vi.mock("@kompast/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kompast/storage")>()),
  getStorageDriver: () => ({
    getDownloadUrl: async (key: string) => `https://storage.test/${key}?sig=1`,
    putObject: async () => {},
    getUploadUrl: async () => {
      throw new Error("unused");
    },
    delete: async () => {},
  }),
}));

type Handler = (opts: { request: Request; params: Record<string, string> }) => Promise<Response>;
const get = (Route.options.server!.handlers as { GET: Handler }).GET;

/**
 * GET /api/issue-attachments/:id. A team member gets the stored file or the JIRA
 * page of a file that isn't stored. Someone outside the team gets 404 for the same
 * attachment, because RLS hides it, the same as one that doesn't exist.
 */
describe("/api/issue-attachments/:attachmentId", () => {
  const orgId = "test-issue-attach-route-org";
  const memberId = "test-iar-member";
  const outsiderId = "test-iar-outsider";
  const teamId = "test-iar-team";
  const userIds = [memberId, outsiderId];
  const tokens: Record<string, string> = {};

  let issueId: string;
  const stored = id("attach");
  const placeholder = id("attach");
  const noSource = id("attach");

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.teamMember).where(eq(schema.teamMember.teamId, teamId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.apikey).where(inArray(schema.apikey.referenceId, userIds));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(inArray(schema.user.id, userIds));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Issue Attachment Route Org", slug: orgId });
    for (const userId of userIds) await admin.insert(schema.user).values({ id: userId, name: userId, email: `${userId}@example.com` });
    await admin.insert(schema.member).values(userIds.map((userId) => ({ id: id("mem"), organizationId: orgId, userId, role: "member" })));
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Attachment Route Team" });
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${memberId}`, teamId, userId: memberId, membershipKey: `${teamId}:${memberId}` });

    const ctx = { userId: memberId, organizationId: orgId };
    const project = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "iar", name: "IAR", actorUserId: memberId }));
    const created = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, {
        organizationId: orgId,
        projectId: project.projectId,
        typeId: project.issueTypes[0]!.id,
        statusId: project.statuses[0]!.id,
        title: "Has files",
        reporterId: memberId,
      }),
    );
    issueId = created.issueId;

    await admin.insert(schema.issueAttachment).values([
      {
        id: stored,
        issueId,
        uploaderId: memberId,
        storageKey: `issue-attachments/${issueId}/${stored}-a.pdf`,
        status: "stored",
        fileName: "a.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
      },
      {
        id: placeholder,
        issueId,
        uploaderId: memberId,
        storageKey: null,
        status: "not_migrated",
        sourceUrl: "https://jira.example.net/secure/attachment/9/big.zip",
        fileName: "big.zip",
        contentType: "application/zip",
        sizeBytes: 15_000_000,
      },
      {
        id: noSource,
        issueId,
        uploaderId: memberId,
        storageKey: null,
        status: "pending",
        sourceUrl: null,
        fileName: "orphan.bin",
        contentType: "application/octet-stream",
        sizeBytes: 5,
      },
    ]);

    const auth = await getAuth();
    for (const userId of userIds) {
      const created = await auth.api.createApiKey({ body: { userId, permissions: { issues: ["read"] }, metadata: { organizationId: orgId } } });
      tokens[userId] = created.key;
    }
  });

  afterAll(cleanup);

  function fetchAs(userId: string | null, attachmentId: string) {
    const headers: Record<string, string> = userId ? { authorization: `Bearer ${tokens[userId]}` } : {};
    return get({ request: new Request(`http://x/api/issue-attachments/${attachmentId}`, { headers }), params: { attachmentId } });
  }

  it("a stored file redirects to its storage URL, never cached", async () => {
    const res = await fetchAs(memberId, stored);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://storage.test/issue-attachments/${issueId}/${stored}-a.pdf?sig=1`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("a file that isn't stored redirects to its JIRA page, and a file with neither gives 404", async () => {
    const jira = await fetchAs(memberId, placeholder);
    expect(jira.status).toBe(302);
    expect(jira.headers.get("location")).toBe("https://jira.example.net/secure/attachment/9/big.zip");

    expect((await fetchAs(memberId, noSource)).status).toBe(404);
  });

  it("someone who can't see the issue gets 404, the same as for an attachment that doesn't exist", async () => {
    expect((await fetchAs(outsiderId, stored)).status).toBe(404);
    expect((await fetchAs(outsiderId, placeholder)).status).toBe(404);
    expect((await fetchAs(memberId, id("attach"))).status).toBe(404);
  });

  it("a request with no token and no session is refused", async () => {
    expect((await fetchAs(null, stored)).status).toBe(401);
  });
});
