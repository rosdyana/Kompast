import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminDb as admin, schema, eq, and, inArray } from "@kompast/db";
import { createProject } from "../project";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";
import { createIssue, recordHistoricalFieldChange } from "../issue";
import { ensureImportedFormerUser, formerMemberEmail, createImportRun } from "../import";
import type { Tx } from "../types";
import { toPlainText, extractMentionedUserIds } from "../rich-text";

/**
 * Loader-fidelity pieces in core, against real Postgres: JIRA key numbers kept
 * on import, former-member placeholders, and field-level history replay.
 */
describe("JIRA loader fidelity (core, real Postgres)", () => {
  const orgId = "test-jira-fid-org";
  const userId = "test-jira-fid-user";
  const teamId = "test-jira-fid-team";
  const ctx = { userId, organizationId: orgId };
  let projectId: string;
  let statusId: string;
  let typeId: string;
  let importRunId: string;

  /** The placeholder users these tests create. Removed by email, so no other test's former members are touched. */
  const formerEmails = ["557058:test-fid-former", "557058:test-fid-lost-ref"].map(formerMemberEmail);

  async function cleanup() {
    await admin.delete(schema.user).where(inArray(schema.user.email, formerEmails));
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
    await admin.insert(schema.organization).values({ id: orgId, name: "JIRA Fidelity Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "Fidelity", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Fidelity Team" });
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });

    const project = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "jfid", name: "JIRA Fid", actorUserId: userId }));
    projectId = project.projectId;
    const [status] = await admin.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, projectId)).limit(1);
    const [type] = await admin.select().from(schema.issueType).where(eq(schema.issueType.projectId, projectId)).limit(1);
    statusId = status!.id;
    typeId = type!.id;
    const run = await withAuthorizedTenant(ctx, (tx) =>
      createImportRun(tx, { organizationId: orgId, projectId, source: "jira", dryRun: false, config: {}, createdBy: userId }),
    );
    importRunId = run.importRunId;
  });

  afterAll(cleanup);

  const newIssue = (tx: Tx, overrides: Partial<Parameters<typeof createIssue>[1]> = {}) =>
    createIssue(tx, {
      organizationId: orgId,
      projectId,
      typeId,
      statusId,
      title: "An issue",
      reporterId: userId,
      origin: "import",
      ...overrides,
    });

  it("keeps the JIRA key number on import when it's free, falls back to the next free number when it isn't, and resumes manual numbering after the highest", async () => {
    const first = await withAuthorizedTenant(ctx, (tx) => newIssue(tx, { keySeq: 123 }));
    expect(first.keySeq).toBe(123);

    const second = await withAuthorizedTenant(ctx, (tx) => newIssue(tx, { keySeq: 123, title: "clash" }));
    expect(second.keySeq).toBe(124);

    const manual = await withAuthorizedTenant(ctx, (tx) => createIssue(tx, { organizationId: orgId, projectId, typeId, statusId, title: "manual", reporterId: userId }));
    expect(manual.keySeq).toBe(125);
  });

  it("refuses a keySeq from anything but an import, and a keySeq that isn't a positive whole number", async () => {
    await expect(withAuthorizedTenant(ctx, (tx) => createIssue(tx, { organizationId: orgId, projectId, typeId, statusId, title: "x", reporterId: userId, keySeq: 9 }))).rejects.toThrow(
      /keySeq can only be set by an import/,
    );
    await expect(withAuthorizedTenant(ctx, (tx) => newIssue(tx, { keySeq: 0 }))).rejects.toThrow(/positive whole number/);
  });

  it("writes a former JIRA member as a placeholder user with no membership, once: a second call finds the same row", async () => {
    const accountId = "557058:test-fid-former";
    const first = await withAuthorizedTenant(ctx, (tx) =>
      ensureImportedFormerUser(tx, { organizationId: orgId, accountId, name: "Gone Person", importRunId }),
    );
    expect(first.created).toBe(true);

    const [row] = await admin.select().from(schema.user).where(eq(schema.user.id, first.userId));
    expect(row).toMatchObject({ name: "Gone Person", email: "jira-557058-test-fid-former@former.invalid", emailVerified: false });
    expect(await admin.select().from(schema.member).where(eq(schema.member.userId, first.userId))).toHaveLength(0);
    expect(await admin.select().from(schema.account).where(eq(schema.account.userId, first.userId))).toHaveLength(0);

    const again = await withAuthorizedTenant(ctx, (tx) => ensureImportedFormerUser(tx, { organizationId: orgId, accountId, name: "Gone Person", importRunId }));
    expect(again).toEqual({ userId: first.userId, created: false });

    const ref = await admin
      .select()
      .from(schema.externalRef)
      .where(and(eq(schema.externalRef.organizationId, orgId), eq(schema.externalRef.source, "jira"), eq(schema.externalRef.sourceId, accountId)));
    expect(ref).toEqual([expect.objectContaining({ entityType: "user", entityId: first.userId })]);
  });

  it("reuses a user already holding the placeholder email (a previous run whose external_ref was lost) instead of colliding", async () => {
    const accountId = "557058:test-fid-lost-ref";
    const [existing] = await admin.insert(schema.user).values({ id: id("user"), name: "Old", email: formerMemberEmail(accountId) }).returning();
    const result = await withAuthorizedTenant(ctx, (tx) => ensureImportedFormerUser(tx, { organizationId: orgId, accountId, name: "Old", importRunId }));
    expect(result).toEqual({ userId: existing!.id, created: false });
    await admin.delete(schema.user).where(eq(schema.user.id, existing!.id));
  });

  it("sanitizes the placeholder email: lowercase, anything outside [a-z0-9._-] becomes '-'", () => {
    expect(formerMemberEmail("557058:AB/Cd e")).toBe("jira-557058-ab-cd-e@former.invalid");
    expect(formerMemberEmail("abc.def_ghi-1")).toBe("jira-abc.def_ghi-1@former.invalid");
  });

  it("replays one field change into issue history with its own timestamp, origin import, and no change to the issue row", async () => {
    const { issueId } = await withAuthorizedTenant(ctx, (tx) => newIssue(tx, { keySeq: 50 }));
    const when = new Date("2023-05-01T10:00:00.000Z");
    await withAuthorizedTenant(ctx, (tx) =>
      recordHistoricalFieldChange(tx, { issueId, actorId: userId, field: "priority", fromValue: "low", toValue: "high", createdAt: when }),
    );

    const rows = await admin.select().from(schema.issueHistory).where(and(eq(schema.issueHistory.issueId, issueId), eq(schema.issueHistory.field, "priority")));
    expect(rows).toEqual([expect.objectContaining({ fromValue: "low", toValue: "high", origin: "import", actorId: userId, createdAt: when })]);
    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue!.priority).toBe("medium");
  });

  it("reads the text of tables and links in toPlainText, and finds mentions inside table cells", () => {
    const blocks = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "See ", styles: {} },
          { type: "link", href: "https://example.com", content: [{ type: "text", text: "the spec", styles: {} }] },
        ],
      },
      {
        type: "table",
        content: {
          type: "tableContent",
          columnWidths: [],
          rows: [
            { cells: [[{ type: "text", text: "Owner", styles: {} }], [{ type: "userMention", props: { userId: "user-ann", name: "Ann" } }]] },
            { cells: [{ type: "tableCell", props: {}, content: [{ type: "text", text: "Done", styles: {} }] }, [{ type: "text", text: "yes", styles: {} }]] },
          ],
        },
      },
    ];

    expect(toPlainText(blocks as never)).toBe("See the spec\nOwner | \nDone | yes");
    expect(extractMentionedUserIds(blocks as never)).toEqual(["user-ann"]);
  });
});
