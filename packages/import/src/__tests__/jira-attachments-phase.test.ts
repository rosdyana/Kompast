import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { schema, eq, and, inArray, adminDb as admin } from "@kompast/db";
import {
  createJiraMigration,
  createProject,
  getJiraMigration,
  listAttachmentsLeftInJira,
  requestJiraDiscovery,
  startJiraMigrationRun,
  withAuthorizedTenant,
  type JiraMigrationPublic,
} from "@kompast/core";
import { id } from "@kompast/core/ids";
import { createJiraClient } from "../jira/client";
import { runJiraMigrationTick, type JiraMigrationAttachmentCursor } from "../jira/migration-runner";

// Local storage writes to a temp dir for this file. Set before any module reads the env (loadEnv caches on first use).
const storage = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const previous = { driver: process.env.STORAGE_DRIVER, dir: process.env.STORAGE_LOCAL_DIR };
  const dir = mkdtempSync(join(tmpdir(), "kompast-jira-attachments-"));
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = dir;
  return { dir, previous };
});

/**
 * The attachments phase end to end: placeholders written by the load, the copy
 * with a mocked JIRA, the inline link rewrites, retries and 404s, resuming across
 * ticks, and a re-run. Real Postgres. Each test seeds its own migration and runs
 * the runner's ticks directly (no claim needed), so files don't race each other.
 */
describe("JIRA migration: attachments phase (real Postgres, mocked JIRA, local storage)", () => {
  const orgId = "test-jira-attach-org";
  const userId = "test-jira-attach-user";
  const teamId = "test-jira-attach-team";
  const ctx = { userId, organizationId: orgId };
  const creatorEmail = `${userId}@example.com`;

  let projectId: string;
  let boardId: string;
  let migrationId: string;
  let jira: ReturnType<typeof fakeJira>;

  async function cleanup() {
    await admin.delete(schema.jiraMigration).where(eq(schema.jiraMigration.organizationId, orgId));
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
    await admin.insert(schema.organization).values({ id: orgId, name: "JIRA Attach Test Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "Importer", email: creatorEmail });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Attach Team" });
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });

    const project = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: "jatt", name: "JIRA Attach", actorUserId: userId }),
    );
    projectId = project.projectId;
    boardId = project.boardId;

    const created = await withAuthorizedTenant(ctx, (tx) =>
      createJiraMigration(tx, ctx, {
        projectId,
        boardId,
        siteUrl: "https://jira.example.net/",
        email: creatorEmail,
        apiToken: "jira-token-attach",
        jiraProjectKey: "JATT",
        jiraBoardId: null,
      }),
    );
    migrationId = created.migrationId;
    jira = fakeJira();
  });

  afterAll(async () => {
    await cleanup();
    rmSync(storage.dir, { recursive: true, force: true });
    if (storage.previous.driver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = storage.previous.driver;
    if (storage.previous.dir === undefined) delete process.env.STORAGE_LOCAL_DIR;
    else process.env.STORAGE_LOCAL_DIR = storage.previous.dir;
  });

  function deps(timeBudgetMs = 60_000) {
    return {
      adminDb: admin,
      withTenantAs: withAuthorizedTenant,
      // One request per attempt: a 500 is not retried inside the client, so the runner's own attempt count is what the test sees.
      createClient: (creds: Parameters<typeof createJiraClient>[0]) =>
        createJiraClient(creds, { fetch: jira.fetchMock as unknown as typeof fetch, sleep: async () => {}, maxAttempts: 1 }),
      timeBudgetMs,
    };
  }

  async function current(): Promise<JiraMigrationPublic> {
    const row = await withAuthorizedTenant(ctx, (tx) => getJiraMigration(tx, migrationId));
    if (!row) throw new Error("migration not visible");
    return row;
  }

  /** Every attachment row of this project's issues, by file name. */
  async function attachmentsByName() {
    const issues = await admin.select({ id: schema.issue.id }).from(schema.issue).where(eq(schema.issue.projectId, projectId));
    const rows = await admin
      .select()
      .from(schema.issueAttachment)
      .where(inArray(schema.issueAttachment.issueId, issues.map((i) => i.id)));
    return new Map(rows.map((r) => [r.fileName, r]));
  }

  async function issueRowByKey(jiraKey: string) {
    const [ref] = await admin
      .select()
      .from(schema.externalRef)
      .where(and(eq(schema.externalRef.organizationId, orgId), eq(schema.externalRef.source, "jira"), eq(schema.externalRef.sourceId, jiraKey)));
    const [row] = await admin.select().from(schema.issue).where(eq(schema.issue.id, ref!.entityId));
    return row!;
  }

  /** Discovery, then the run's start, then the first tick that loads the one page. Leaves the migration in the attachments phase. */
  async function loadToAttachments(): Promise<{ importRunId: string }> {
    await withAuthorizedTenant(ctx, (tx) => requestJiraDiscovery(tx, ctx, migrationId));
    await runJiraMigrationTick(deps(), await current());
    const { importRunId } = await withAuthorizedTenant(ctx, (tx) => startJiraMigrationRun(tx, ctx, migrationId));
    await runJiraMigrationTick(deps(), await current());
    return { importRunId };
  }

  it("the load writes placeholders by size, inline use and the hard cap, and links the files that won't be copied", async () => {
    await loadToAttachments();

    const m = await current();
    expect(m.state).toBe("running");
    expect(m.cursor).toMatchObject({ phase: "attachments" });
    expect(jira.state.downloads.size).toBe(0);

    const byName = await attachmentsByName();
    expect(Object.fromEntries([...byName].map(([name, row]) => [name, row.status]))).toEqual({
      "shot.png": "pending",
      "big.zip": "not_migrated",
      "huge.mov": "not_migrated",
      "notes.txt": "pending",
      "report.pdf": "pending",
      "gone.txt": "pending",
      "flaky.bin": "pending",
    });
    expect(byName.get("huge.mov")).toMatchObject({
      storageKey: null,
      sourceUrl: "https://jira.example.net/secure/attachment/10003/huge.mov",
      sizeBytes: 150 * 1024 * 1024,
    });
    expect(byName.get("shot.png")!.uploaderId).toBe(userId);

    // A placeholder's external ref is keyed by the JIRA issue key and the JIRA attachment id.
    const [ref] = await admin.select().from(schema.externalRef).where(eq(schema.externalRef.entityId, byName.get("shot.png")!.id));
    expect(ref).toMatchObject({ sourceId: "JATT-1/10001", entityType: "attachment" });

    // The file that won't be copied is already a link to JIRA in the description, so no broken image is stored.
    const issue = await issueRowByKey("JATT-1");
    expect(JSON.stringify(issue.descriptionJson)).toContain("huge.mov (not copied — open in JIRA)");
    expect(JSON.stringify(issue.descriptionJson)).not.toContain("/attachment/content/10003");

    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, (m.cursor as unknown as JiraMigrationAttachmentCursor).importRunId));
    expect(run!.counts).toMatchObject({ attachmentsQueued: 5, attachmentsNotMigrated: 2, inlineAttachmentsOverLimit: 1, issuesCreated: 1 });
  });

  it("copies the pending files, rewrites the inline URLs, retries, fails a deleted file at once, resumes across ticks and ends synced", async () => {
    await loadToAttachments();

    // Tick 3: the first download takes longer than the tick's budget, so the tick stops after one slice.
    jira.state.delayFirstDownloadMs = 80;
    await runJiraMigrationTick(deps(50), await current());
    let m = await current();
    expect(m.state).toBe("running");
    expect(m.progress).toMatchObject({ phase: "attachments", failed: 1 });
    const pendingAfterFirstTick = [...(await attachmentsByName()).values()].filter((r) => r.status === "pending").map((r) => r.fileName);
    expect(pendingAfterFirstTick).toEqual(["flaky.bin"]);

    // Tick 4 finishes the copies: the flaky file gets its remaining attempts.
    await runJiraMigrationTick(deps(), await current());
    m = await current();
    expect(m.state).toBe("synced");
    expect(m.lastSyncedAt).not.toBeNull();
    expect(m.leaseExpiresAt).toBeNull();

    const byName = await attachmentsByName();
    expect(Object.fromEntries([...byName].map(([name, row]) => [name, row.status]))).toEqual({
      "shot.png": "stored",
      "big.zip": "not_migrated",
      "huge.mov": "not_migrated",
      "notes.txt": "stored",
      "report.pdf": "stored",
      "gone.txt": "failed",
      "flaky.bin": "failed",
    });
    expect(byName.get("gone.txt")).toMatchObject({ attempts: 1, error: expect.stringContaining("404") });
    expect(byName.get("flaky.bin")).toMatchObject({ attempts: 3, error: expect.stringContaining("JIRA API error (500)") });

    // Each download was asked for once, except the flaky file (three tries) and the deleted one (one try, no retry).
    expect(Object.fromEntries(jira.state.downloads)).toEqual({ "10001": 1, "10004": 1, "10005": 1, "10006": 1, "10007": 3 });

    // Stored bytes sit under the attachment's own key, and hold exactly the bytes JIRA sent.
    const shot = byName.get("shot.png")!;
    expect(shot.storageKey).toBe(`issue-attachments/${shot.issueId}/${shot.id}-shot.png`);
    expect(readFileSync(join(storage.dir, shot.storageKey!)).length).toBe(1024);
    expect(readFileSync(join(storage.dir, byName.get("report.pdf")!.storageKey!)).length).toBe(3000);

    // Inline references: the stored image and the stored comment's file now point at the stable route.
    const issue = await issueRowByKey("JATT-1");
    const description = JSON.stringify(issue.descriptionJson);
    expect(description).toContain(`/api/issue-attachments/${shot.id}`);
    expect(description).not.toContain("/attachment/content/10001");
    expect(description).toContain("gone.txt (not copied — open in JIRA)");
    expect(description).toContain("https://jira.example.net/secure/attachment/10006/gone.txt");
    const [comment] = await admin.select().from(schema.issueComment).where(eq(schema.issueComment.issueId, issue.id));
    expect(JSON.stringify(comment!.bodyJson)).toContain(`/api/issue-attachments/${byName.get("notes.txt")!.id}`);

    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.migrationId, migrationId));
    expect(run!.counts).toMatchObject({
      attachmentsStored: 3,
      attachmentsFailed: 2,
      attachmentBytesStored: 1024 + 300 + 3000,
      inlineBlocksRewritten: 2,
      attachmentsNotMigrated: 2,
    });

    // The files left in JIRA are the ones not copied and the ones that failed.
    const left = await withAuthorizedTenant(ctx, (tx) => listAttachmentsLeftInJira(tx, ctx, projectId));
    expect(left.map((r) => [r.fileName, r.status]).sort()).toEqual([
      ["big.zip", "not_migrated"],
      ["flaky.bin", "failed"],
      ["gone.txt", "failed"],
      ["huge.mov", "not_migrated"],
    ]);
    expect(left.find((r) => r.fileName === "flaky.bin")).toMatchObject({ issueKey: "JATT-1", error: expect.stringContaining("500") });
  });

  it("a re-run doesn't download stored files again, re-queues the failed ones, and creates no duplicate rows", async () => {
    await loadToAttachments();
    await runJiraMigrationTick(deps(), await current());
    expect(await current()).toMatchObject({ state: "synced" });
    const before = await attachmentsByName();
    expect(before.size).toBe(7);

    // This time the flaky file's JIRA is back, and the deleted file is still gone.
    jira.state.flakyOk = true;
    await withAuthorizedTenant(ctx, (tx) => startJiraMigrationRun(tx, ctx, migrationId));
    await runJiraMigrationTick(deps(), await current());
    await runJiraMigrationTick(deps(), await current());

    expect(await current()).toMatchObject({ state: "synced" });
    const after = await attachmentsByName();
    expect(after.size).toBe(7);
    expect(after.get("flaky.bin")).toMatchObject({ status: "stored" });
    expect(after.get("gone.txt")).toMatchObject({ status: "failed", attempts: 1 });
    expect(after.get("shot.png")!.id).toBe(before.get("shot.png")!.id);

    // Stored files were not fetched again; the re-queued ones were.
    expect(jira.state.downloads.get("10001")).toBe(1);
    expect(jira.state.downloads.get("10004")).toBe(1);
    expect(jira.state.downloads.get("10005")).toBe(1);
    expect(jira.state.downloads.get("10006")).toBe(2);
    expect(jira.state.downloads.get("10007")).toBe(4);
  });
});

// ── fake JIRA ───────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const importer = { accountId: "acc-importer", displayName: "Importer", emailAddress: "test-jira-attach-user@example.com", active: true, accountType: "atlassian" };

const SITE = "https://jira.example.net";

/** The bytes JIRA holds for each attachment that is downloaded (the sizes match what the issue declares). */
const CONTENT: Record<string, { size: number; mime: string }> = {
  "10001": { size: 1024, mime: "image/png" },
  "10004": { size: 300, mime: "text/plain" },
  "10005": { size: 3000, mime: "application/pdf" },
  "10007": { size: 200, mime: "application/octet-stream" },
};

const ATTACHMENTS = [
  { id: "10001", filename: "shot.png", mimeType: "image/png", size: 1024 },
  { id: "10002", filename: "big.zip", mimeType: "application/zip", size: 15 * 1024 * 1024 },
  { id: "10003", filename: "huge.mov", mimeType: "video/quicktime", size: 150 * 1024 * 1024 },
  { id: "10004", filename: "notes.txt", mimeType: "text/plain", size: 300 },
  { id: "10005", filename: "report.pdf", mimeType: "application/pdf", size: 3000 },
  { id: "10006", filename: "gone.txt", mimeType: "text/plain", size: 100 },
  { id: "10007", filename: "flaky.bin", mimeType: "application/octet-stream", size: 200 },
].map((a) => ({
  ...a,
  content: `${SITE}/rest/api/3/attachment/content/${a.id}`,
  created: "2024-01-06T00:00:00.000+0000",
  author: importer,
}));

/** An ADF block holding one file media node, named by the file it points at (matched by name). */
const media = (alt: string) => ({
  type: "mediaSingle",
  attrs: { layout: "center" },
  content: [{ type: "media", attrs: { type: "file", id: `media-${alt}`, collection: "", alt } }],
});

const DESCRIPTION = {
  type: "doc",
  version: 1,
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Screenshots, logs and the big recording" }] },
    media("shot.png"),
    media("huge.mov"),
    media("gone.txt"),
  ],
};

const COMMENT_BODY = { type: "doc", version: 1, content: [media("notes.txt")] };

const JATT_1 = {
  id: "JATT-1",
  key: "JATT-1",
  fields: {
    summary: "Attachments everywhere",
    issuetype: { name: "Task", subtask: false },
    status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
    assignee: null,
    reporter: importer,
    creator: importer,
    priority: { name: "Medium" },
    labels: [],
    description: DESCRIPTION,
    created: "2024-01-05T00:00:00.000+0000",
    issuelinks: [],
    comment: {
      total: 1,
      comments: [{ id: "c1", author: importer, body: COMMENT_BODY, created: "2024-01-07T00:00:00.000+0000" }],
    },
    worklog: { total: 0, worklogs: [] },
    attachment: ATTACHMENTS,
  },
};

function fakeJira() {
  const state = {
    downloads: new Map<string, number>(),
    delayFirstDownloadMs: 0,
    flakyOk: false,
  };
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.pathname;

    if (path === "/rest/api/3/myself") return json({ accountId: "acc-importer", displayName: "Importer", emailAddress: importer.emailAddress });
    if (path === "/rest/api/3/project/JATT") return json({ id: "20001", key: "JATT", name: "JIRA Attach" });
    if (path === "/rest/agile/1.0/board") return json({ values: [], isLast: true });
    if (path === "/rest/api/3/project/JATT/statuses") {
      return json([{ name: "Task", subtask: false, statuses: [{ name: "To Do", statusCategory: { key: "new" } }] }]);
    }
    if (path === "/rest/api/3/priority") return json([{ name: "Medium" }]);
    if (path === "/rest/api/3/field") return json([]);
    if (path === "/rest/api/3/search/jql") return json({ issues: [JATT_1], isLast: true });

    if (path.startsWith("/rest/api/3/attachment/content/")) {
      const attachmentId = path.slice(path.lastIndexOf("/") + 1);
      state.downloads.set(attachmentId, (state.downloads.get(attachmentId) ?? 0) + 1);
      if (state.delayFirstDownloadMs > 0) {
        const ms = state.delayFirstDownloadMs;
        state.delayFirstDownloadMs = 0;
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      if (attachmentId === "10006") return new Response("Attachment does not exist", { status: 404 });
      if (attachmentId === "10007" && !state.flakyOk) return new Response("boom", { status: 500 });
      const file = CONTENT[attachmentId];
      if (!file) return new Response("no such file in this fake", { status: 404 });
      return new Response(Buffer.alloc(file.size, 7), { status: 200, headers: { "content-type": file.mime } });
    }
    return new Response(`no route for ${path}`, { status: 404 });
  });
  return { fetchMock, state };
}
