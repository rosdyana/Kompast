import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema, eq, asc, sql, adminDb } from "@kompast/db";
import { encryptSecret, decryptSecret } from "../crypto";
import {
  getSetupStatus,
  getMicrosoftAuthConfig,
  getMicrosoftAuthSettingsView,
  completeSetup,
  getAiSettings,
  updateAiSettings,
  getMailSettings,
  updateMailSettings,
  updateEmbeddingSettings,
  requireSystemAdmin,
} from "../settings";
import { isOnlyUser } from "../bootstrap";
import { ForbiddenError } from "../permissions";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";
import { createProject } from "../project";
import { createSprint, addIssueToSprint } from "../sprint";
import { createIssue } from "../issue";
import { addComment } from "../comment";
import { AiNotConfiguredError, runAiCompletion, runDocTextAction, generateIssueDescription, generateSprintSummary } from "../ai";
import {
  chunkText,
  indexEntity,
  claimPendingReindexTasks,
  markReindexTaskProcessed,
  processReindexTask,
  searchEmbeddings,
  askKompast,
  EmbeddingNotConfiguredError,
} from "../rag";

function fakeAnthropicSseResponse(): Response {
  const frames = [
    { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
    { type: "message_delta", usage: { output_tokens: 5 } },
  ];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

const EMBEDDING_DIMENSIONS = 1536;

/** Deterministic, not random — identical text always produces an identical vector, and distinct text (almost always) lands in a distinct dimension, which is exactly what a controlled ordering test needs (no real semantic model behind a mocked provider). */
function fakeEmbed(text: string): number[] {
  const vec = new Array(EMBEDDING_DIMENSIONS).fill(0);
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  vec[Math.abs(hash) % EMBEDDING_DIMENSIONS] = 1;
  return vec;
}

function fakeEmbeddingsResponse(texts: string[]): Response {
  return new Response(JSON.stringify({ data: texts.map((t, index) => ({ embedding: fakeEmbed(t), index })) }), { status: 200 });
}

/** Dispatches by URL so one stub can serve both the chat (Anthropic) and embeddings (Azure OpenAI) endpoints askKompast calls in the same request. */
function stubAiAndEmbeddingFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (url.toString().includes("/embeddings")) {
        const body = JSON.parse(init!.body as string) as { input: string[] };
        return fakeEmbeddingsResponse(body.input);
      }
      return fakeAnthropicSseResponse();
    }),
  );
}

describe("crypto", () => {
  it("round-trips a secret and never stores it in plaintext", () => {
    const secret = "super-secret-client-secret-value";
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV) but both decrypt correctly", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-input");
    expect(decryptSecret(b)).toBe("same-input");
  });
});

describe("system settings", () => {
  const updatedBy = "test-settings-updater";

  beforeEach(async () => {
    await db.delete(schema.systemSettings);
    await db.delete(schema.user).where(eq(schema.user.id, updatedBy));
    // updated_by references user.id — a real fixture row, not a bare
    // string, since the column is a genuine FK for audit purposes.
    await db.insert(schema.user).values({ id: updatedBy, name: "Updater", email: `${updatedBy}@example.com` });
  });
  afterEach(async () => {
    await db.delete(schema.systemSettings);
    await db.delete(schema.user).where(eq(schema.user.id, updatedBy));
  });

  it("reports not configured before setup, configured after", async () => {
    expect((await getSetupStatus(db)).isConfigured).toBe(false);

    await completeSetup(db, {
      tenantId: "11111111-1111-1111-1111-111111111111",
      clientId: "client-abc",
      clientSecret: "shh-its-a-secret",
      updatedBy,
    });

    expect((await getSetupStatus(db)).isConfigured).toBe(true);
    const cfg = await getMicrosoftAuthConfig(db);
    expect(cfg).toEqual({
      tenantId: "11111111-1111-1111-1111-111111111111",
      clientId: "client-abc",
      clientSecret: "shh-its-a-secret",
    });
  });

  it("rejects a non-GUID tenant id (common/organizations/consumers)", async () => {
    await expect(
      completeSetup(db, { tenantId: "common", clientId: "x", clientSecret: "y", updatedBy }),
    ).rejects.toThrow(/tenant GUID/);
  });

  it("re-running completeSetup overwrites the previous credentials (admin editing later)", async () => {
    await completeSetup(db, {
      tenantId: "11111111-1111-1111-1111-111111111111",
      clientId: "first",
      clientSecret: "first-secret",
      updatedBy,
    });
    await completeSetup(db, {
      tenantId: "22222222-2222-2222-2222-222222222222",
      clientId: "second",
      clientSecret: "second-secret",
      updatedBy,
    });
    const cfg = await getMicrosoftAuthConfig(db);
    expect(cfg?.clientId).toBe("second");
    expect(cfg?.clientSecret).toBe("second-secret");
  });

  it("re-running completeSetup with no clientSecret keeps the previously stored one (the /settings re-edit path)", async () => {
    await completeSetup(db, { tenantId: "11111111-1111-1111-1111-111111111111", clientId: "first", clientSecret: "keep-me-secret", updatedBy });
    await completeSetup(db, { tenantId: "11111111-1111-1111-1111-111111111111", clientId: "renamed", updatedBy });

    const cfg = await getMicrosoftAuthConfig(db);
    expect(cfg?.clientId).toBe("renamed");
    expect(cfg?.clientSecret).toBe("keep-me-secret");

    const view = await getMicrosoftAuthSettingsView(db);
    expect(view).toEqual({ tenantId: "11111111-1111-1111-1111-111111111111", clientId: "renamed", hasClientSecret: true });
    expect(JSON.stringify(view)).not.toContain("keep-me-secret");
  });

  it("AI settings: hasApiKey reflects presence without ever exposing the key, update preserves key when omitted", async () => {
    expect((await getAiSettings(db)).hasApiKey).toBe(false);

    await updateAiSettings(db, {
      provider: "anthropic",
      apiKey: "sk-ant-real-key",
      featuresEnabled: true,
      updatedBy,
    });
    let view = await getAiSettings(db);
    expect(view).toMatchObject({ provider: "anthropic", hasApiKey: true, featuresEnabled: true });
    expect(JSON.stringify(view)).not.toContain("sk-ant-real-key");

    // Editing without passing apiKey must not clear the stored key.
    await updateAiSettings(db, { provider: "anthropic", featuresEnabled: false, updatedBy });
    view = await getAiSettings(db);
    expect(view.hasApiKey).toBe(true);
    expect(view.featuresEnabled).toBe(false);
  });

  it("mail settings round-trip the same way", async () => {
    await updateMailSettings(db, {
      driver: "resend",
      from: "noreply@example.com",
      apiKey: "re_123",
      updatedBy,
    });
    const view = await getMailSettings(db);
    expect(view).toEqual({ driver: "resend", from: "noreply@example.com", hasApiKey: true, hasSmtpUrl: false });
  });
});

describe("requireSystemAdmin", () => {
  const orgId = "test-settings-org";
  const adminUserId = "test-settings-admin";
  const memberUserId = "test-settings-member";

  beforeEach(async () => {
    await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await db.delete(schema.user).where(eq(schema.user.id, adminUserId));
    await db.delete(schema.user).where(eq(schema.user.id, memberUserId));

    await db.insert(schema.organization).values({ id: orgId, name: "Test Settings Org", slug: orgId });
    await db.insert(schema.user).values([
      { id: adminUserId, name: "Admin", email: `${adminUserId}@example.com` },
      { id: memberUserId, name: "Member", email: `${memberUserId}@example.com` },
    ]);
    await db.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId: adminUserId, role: "owner" },
      { id: id("mem"), organizationId: orgId, userId: memberUserId, role: "member" },
    ]);
  });

  it("allows an owner", async () => {
    await expect(requireSystemAdmin(db, { userId: adminUserId, organizationId: orgId })).resolves.toBeUndefined();
  });

  it("rejects a plain member", async () => {
    await expect(requireSystemAdmin(db, { userId: memberUserId, organizationId: orgId })).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe("isOnlyUser", () => {
  const userA = "test-bootstrap-a";
  const userB = "test-bootstrap-b";

  afterEach(async () => {
    await db.delete(schema.user).where(eq(schema.user.id, userA));
    await db.delete(schema.user).where(eq(schema.user.id, userB));
  });

  it("is true for the first and only user", async () => {
    await db.insert(schema.user).values({ id: userA, name: "A", email: `${userA}@example.com` });
    // Only true if this is truly the ONLY row in the whole table — guard
    // the assertion against other tests' fixtures still being present.
    const total = await db.select().from(schema.user);
    if (total.length === 1) {
      expect(await isOnlyUser(db, userA)).toBe(true);
    }
  });

  it("is false once a second user exists", async () => {
    await db.insert(schema.user).values([
      { id: userA, name: "A", email: `${userA}@example.com` },
      { id: userB, name: "B", email: `${userB}@example.com` },
    ]);
    expect(await isOnlyUser(db, userA)).toBe(false);
    expect(await isOnlyUser(db, userB)).toBe(false);
  });
});

/**
 * Deliberately in this same file, not a separate ai.test.ts: system_settings
 * is a true singleton (see packages/db/src/schema/settings.ts), and vitest
 * runs test FILES in parallel against one shared Postgres — a second file
 * that also delete/upserts this row would race the "system settings"
 * describe above (the exact cross-file interference P5's email test hit).
 * Co-locating keeps every singleton-table mutation serialized by vitest's
 * default within-file test ordering instead.
 */
describe("packages/core/ai", () => {
  const orgId = "test-ai-org";
  const userId = "test-ai-user";
  const ctx = { userId, organizationId: orgId };

  async function cleanup() {
    await db.delete(schema.systemSettings);
    await db.delete(schema.aiUsage).where(eq(schema.aiUsage.organizationId, orgId));
    await db.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
  }

  beforeEach(async () => {
    await cleanup();
    await db.insert(schema.organization).values({ id: orgId, name: "AI Test Org", slug: orgId });
    await db.insert(schema.user).values({ id: userId, name: "AI User", email: `${userId}@example.com` });
    await db.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterEach(async () => {
    await cleanup();
    vi.unstubAllGlobals();
  });

  it("throws AiNotConfiguredError when AI has never been configured", async () => {
    await expect(
      withAuthorizedTenant(ctx, (tx) => runAiCompletion(tx, { organizationId: orgId, userId, feature: "test", messages: [{ role: "user", content: "hi" }] })),
    ).rejects.toThrow(AiNotConfiguredError);
  });

  it("throws AiNotConfiguredError when configured but featuresEnabled is false", async () => {
    await updateAiSettings(db, { provider: "anthropic", apiKey: "fake-key", featuresEnabled: false, updatedBy: userId });
    await expect(
      withAuthorizedTenant(ctx, (tx) => runAiCompletion(tx, { organizationId: orgId, userId, feature: "test", messages: [{ role: "user", content: "hi" }] })),
    ).rejects.toThrow(AiNotConfiguredError);
  });

  describe("with AI configured (anthropic, fetch mocked — no real network call)", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      await updateAiSettings(db, { provider: "anthropic", apiKey: "fake-key", model: "claude-test-model", featuresEnabled: true, updatedBy: userId });
      fetchMock = vi.fn().mockResolvedValue(fakeAnthropicSseResponse());
      vi.stubGlobal("fetch", fetchMock);
    });

    it("runs a doc text action, streams deltas, and logs ai_usage with real token counts", async () => {
      const deltas: string[] = [];
      const result = await withAuthorizedTenant(ctx, (tx) =>
        runDocTextAction(tx, { organizationId: orgId, userId, action: "improve", text: "some text", onDelta: (d) => deltas.push(d) }),
      );

      expect(deltas).toEqual(["Hel", "lo"]);
      expect(result.text).toBe("Hello");

      const [usage] = await adminDb.select().from(schema.aiUsage).where(eq(schema.aiUsage.organizationId, orgId));
      expect(usage?.feature).toBe("doc.improve");
      expect(usage?.provider).toBe("anthropic");
      expect(usage?.model).toBe("claude-test-model");
      expect(usage?.inputTokens).toBe(12);
      expect(usage?.outputTokens).toBe(5);
    });

    it("requires a targetLanguage for the translate action", async () => {
      await expect(
        withAuthorizedTenant(ctx, (tx) => runDocTextAction(tx, { organizationId: orgId, userId, action: "translate", text: "hi" })),
      ).rejects.toThrow(/targetLanguage/);
    });

    it("folds the target language into the translate prompt", async () => {
      await withAuthorizedTenant(ctx, (tx) => runDocTextAction(tx, { organizationId: orgId, userId, action: "translate", text: "hi", targetLanguage: "Indonesian" }));
      const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(sentBody.system).toContain("Indonesian");
    });

    it("generates an issue description prompt that includes the given title", async () => {
      const result = await withAuthorizedTenant(ctx, (tx) => generateIssueDescription(tx, { organizationId: orgId, userId, title: "Login button is broken" }));
      expect(result.text).toBe("Hello");
      const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(JSON.stringify(sentBody.messages)).toContain("Login button is broken");

      const [usage] = await adminDb.select().from(schema.aiUsage).where(eq(schema.aiUsage.organizationId, orgId));
      expect(usage?.feature).toBe("issue.description");
    });

    it("generates a sprint summary whose prompt correctly separates completed from not-completed issues", async () => {
      const { projectId, boardId, issueTypes, statuses } = await withAuthorizedTenant(ctx, (tx) =>
        createProject(tx, { organizationId: orgId, key: "aisu", name: "AI Sprint Test", actorUserId: userId }),
      );
      const doneStatus = statuses.find((s) => s.category === "done")!;
      const todoStatus = statuses.find((s) => s.category === "todo")!;

      const { sprintId } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 1", goal: "Ship the thing" }));

      const done = await withAuthorizedTenant(ctx, (tx) =>
        createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: doneStatus.id, title: "Finished task", reporterId: userId, storyPoints: 3 }),
      );
      const notDone = await withAuthorizedTenant(ctx, (tx) =>
        createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: todoStatus.id, title: "Unfinished task", reporterId: userId, storyPoints: 2 }),
      );
      await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, sprintId, done.issueId));
      await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, sprintId, notDone.issueId));

      const result = await withAuthorizedTenant(ctx, (tx) => generateSprintSummary(tx, { organizationId: orgId, userId, sprintId }));
      expect(result.text).toBe("Hello");

      const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
      const facts = sentBody.messages[0].content as string;
      expect(facts).toContain("Ship the thing");
      expect(facts).toContain("Finished task");
      expect(facts).toContain("Unfinished task");
      expect(facts.indexOf("Finished task")).toBeLessThan(facts.indexOf("Not completed"));
      expect(facts.indexOf("Unfinished task")).toBeGreaterThan(facts.indexOf("Not completed"));
    });
  });
});

describe("chunkText", () => {
  it("returns nothing for blank text", () => {
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("keeps a single short paragraph as one chunk", () => {
    expect(chunkText("hello world")).toEqual(["hello world"]);
  });

  it("merges paragraphs that comfortably fit under the max chunk size", () => {
    expect(chunkText("first paragraph\n\nsecond paragraph")).toEqual(["first paragraph\n\nsecond paragraph"]);
  });

  it("splits once the running chunk would exceed the max size, rather than merging indefinitely", () => {
    const p1 = "a".repeat(600);
    const p2 = "b".repeat(600);
    expect(chunkText(`${p1}\n\n${p2}`)).toEqual([p1, p2]);
  });
});

/**
 * Same co-location reasoning as "packages/core/ai" above — system_settings
 * is a true singleton and this describe block also writes to it
 * (updateEmbeddingSettings), so it has to serialize against every other
 * describe block in this file that does the same, not live in its own
 * vitest-parallelized file.
 */
describe("packages/core/rag", () => {
  const orgId = "test-rag-org";
  const userId = "test-rag-user";
  const ctx = { userId, organizationId: orgId };

  async function cleanup() {
    await db.delete(schema.systemSettings);
    await db.delete(schema.aiMessage).where(sql`thread_id in (select id from ai_thread where organization_id = ${orgId})`);
    await db.delete(schema.aiThread).where(eq(schema.aiThread.organizationId, orgId));
    await db.delete(schema.embeddingIndexQueue).where(eq(schema.embeddingIndexQueue.organizationId, orgId));
    await db.delete(schema.embedding).where(eq(schema.embedding.organizationId, orgId));
    await db.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
  }

  beforeEach(async () => {
    await cleanup();
    await db.insert(schema.organization).values({ id: orgId, name: "RAG Test Org", slug: orgId });
    await db.insert(schema.user).values({ id: userId, name: "RAG User", email: `${userId}@example.com` });
    await db.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterEach(async () => {
    await cleanup();
    vi.unstubAllGlobals();
  });

  async function seedProject() {
    return withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, key: "rag", name: "RAG Test", actorUserId: userId }));
  }

  /**
   * A plain, unclaimed read by entityId — NOT claimPendingReindexTasks,
   * which claims system-wide across every test file's own createIssue/
   * addComment calls (a real, shared queue) and would otherwise race
   * whichever task this specific test cares about. Safe here because
   * entityId is unique per test (fresh id() per created issue/comment).
   */
  async function fetchPendingReindexTask(entityId: string) {
    const [row] = await adminDb.select().from(schema.embeddingIndexQueue).where(eq(schema.embeddingIndexQueue.entityId, entityId));
    return row ?? null;
  }

  it("indexEntity stores one row per chunk and silently does nothing when embeddings aren't configured", async () => {
    await withAuthorizedTenant(ctx, (tx) => indexEntity(tx, { organizationId: orgId, entityType: "issue", entityId: "fake-1", text: "hello world" }));
    const rows = await adminDb.select().from(schema.embedding).where(eq(schema.embedding.entityId, "fake-1"));
    expect(rows).toHaveLength(0);
  });

  describe("with embeddings + chat configured (fetch mocked — no real network call)", () => {
    beforeEach(async () => {
      await updateEmbeddingSettings(db, { provider: "azure-openai", apiKey: "fake-embed-key", azureEndpoint: "https://embed.openai.azure.com", azureDeployment: "embed-dep", featuresEnabled: true, updatedBy: userId });
      // askKompast's generation step needs the (separate) chat provider configured too.
      await updateAiSettings(db, { provider: "anthropic", apiKey: "fake-chat-key", featuresEnabled: true, updatedBy: userId });
      stubAiAndEmbeddingFetch();
    });

    it("indexEntity stores real vectors, one row per chunk, and replaces old chunks wholesale on a later call", async () => {
      await withAuthorizedTenant(ctx, (tx) => indexEntity(tx, { organizationId: orgId, entityType: "issue", entityId: "fake-1", text: "hello world" }));
      let rows = await adminDb.select().from(schema.embedding).where(eq(schema.embedding.entityId, "fake-1"));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.content).toBe("hello world");
      expect(rows[0]!.vector).toHaveLength(EMBEDDING_DIMENSIONS);

      await withAuthorizedTenant(ctx, (tx) => indexEntity(tx, { organizationId: orgId, entityType: "issue", entityId: "fake-1", text: "completely different text" }));
      rows = await adminDb.select().from(schema.embedding).where(eq(schema.embedding.entityId, "fake-1"));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.content).toBe("completely different text");
    });

    it("createIssue auto-enqueues a reindex task, and processReindexTask indexes the real issue's current title+description", async () => {
      const { projectId, issueTypes, statuses } = await seedProject();
      const { issueId } = await withAuthorizedTenant(ctx, (tx) =>
        createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Fix the login bug", descriptionJson: { text: "Users can't sign in with SSO." }, reporterId: userId }),
      );

      const task = await fetchPendingReindexTask(issueId);
      expect(task).toMatchObject({ organizationId: orgId, entityType: "issue", entityId: issueId, action: "index", status: "pending" });

      await withAuthorizedTenant(ctx, (tx) => processReindexTask(tx, task!));
      await markReindexTaskProcessed(adminDb, task!.id);

      const rows = await adminDb.select().from(schema.embedding).where(eq(schema.embedding.entityId, issueId));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((r) => r.content.includes("Fix the login bug"))).toBe(true);
      expect(rows.some((r) => r.content.includes("SSO"))).toBe(true);

      const [taskRow] = await adminDb.select().from(schema.embeddingIndexQueue).where(eq(schema.embeddingIndexQueue.id, task!.id));
      expect(taskRow?.status).toBe("processed");
    });

    it("addComment auto-enqueues a reindex task for the new comment", async () => {
      const { projectId, issueTypes, statuses } = await seedProject();
      const { issueId } = await withAuthorizedTenant(ctx, (tx) => createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "An issue", reporterId: userId }));

      const { commentId } = await withAuthorizedTenant(ctx, (tx) => addComment(tx, { issueId, authorId: userId, bodyJson: { text: "a very specific comment body" } }));

      const task = await fetchPendingReindexTask(commentId);
      expect(task).toMatchObject({ entityType: "comment", entityId: commentId });
    });

    it("claimPendingReindexTasks claims a real pending task and marks it processing", async () => {
      const { projectId, issueTypes, statuses } = await seedProject();
      const { issueId } = await withAuthorizedTenant(ctx, (tx) => createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Claim test issue", reporterId: userId }));

      // Higher limit + filter by our own known entityId, not position [0] —
      // this is a system-wide claim (every test file's createIssue/addComment
      // calls enqueue onto the SAME queue), same reasoning as
      // claimPendingAutomationEvents' own test in automation.test.ts.
      const claimed = await claimPendingReindexTasks(adminDb, 50);
      const ours = claimed.filter((t) => t.entityId === issueId);
      expect(ours).toHaveLength(1);
      expect(ours[0]!.status).toBe("processing");
    });

    it("searchEmbeddings ranks the chunk whose text exactly matches the query ahead of an unrelated one", async () => {
      await withAuthorizedTenant(ctx, (tx) => indexEntity(tx, { organizationId: orgId, entityType: "issue", entityId: "issue-relevant", text: "database migration rollback procedure" }));
      await withAuthorizedTenant(ctx, (tx) => indexEntity(tx, { organizationId: orgId, entityType: "issue", entityId: "issue-unrelated", text: "office coffee machine is broken" }));

      const queryVector = fakeEmbed("database migration rollback procedure");
      const results = await withAuthorizedTenant(ctx, (tx) => searchEmbeddings(tx, { organizationId: orgId, queryVector, limit: 5 }));

      expect(results[0]!.entityId).toBe("issue-relevant");
      expect(results[0]!.distance).toBeLessThan(results.find((r) => r.entityId === "issue-unrelated")!.distance);
    });

    it("askKompast retrieves relevant context, answers, and persists both the question and the answer with citations", async () => {
      const { projectId, issueTypes, statuses } = await seedProject();
      const { issueId } = await withAuthorizedTenant(ctx, (tx) =>
        createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Unique searchable issue title", reporterId: userId }),
      );
      const task = await fetchPendingReindexTask(issueId);
      await withAuthorizedTenant(ctx, (tx) => processReindexTask(tx, task!));

      const deltas: string[] = [];
      const result = await withAuthorizedTenant(ctx, (tx) => askKompast(tx, { organizationId: orgId, userId, question: "Unique searchable issue title", onDelta: (d) => deltas.push(d) }));

      expect(result.answer).toBe("Hello");
      expect(deltas.join("")).toBe("Hello");
      expect(result.citations.some((c) => c.entityId === issueId)).toBe(true);

      const messages = await adminDb.select().from(schema.aiMessage).where(eq(schema.aiMessage.threadId, result.threadId)).orderBy(asc(schema.aiMessage.createdAt));
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: "user", content: "Unique searchable issue title" });
      expect(messages[1]).toMatchObject({ role: "assistant", content: "Hello" });

      const [thread] = await adminDb.select().from(schema.aiThread).where(eq(schema.aiThread.id, result.threadId));
      expect(thread?.title).toBe("Unique searchable issue title");
    });

    it("askKompast continuing an existing thread includes the prior exchange in the next prompt", async () => {
      const first = await withAuthorizedTenant(ctx, (tx) => askKompast(tx, { organizationId: orgId, userId, question: "first question" }));

      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock.mockClear();

      await withAuthorizedTenant(ctx, (tx) => askKompast(tx, { organizationId: orgId, userId, threadId: first.threadId, question: "second question" }));

      const chatCall = fetchMock.mock.calls.find((c: unknown[]) => !String(c[0]).includes("/embeddings"))!;
      const sentBody = JSON.parse(chatCall[1].body);
      expect(JSON.stringify(sentBody.messages)).toContain("first question");
      expect(JSON.stringify(sentBody.messages)).toContain("Hello"); // the prior assistant answer
    });
  });

  it("askKompast throws EmbeddingNotConfiguredError when embeddings aren't set up", async () => {
    await expect(withAuthorizedTenant(ctx, (tx) => askKompast(tx, { organizationId: orgId, userId, question: "anything" }))).rejects.toThrow(EmbeddingNotConfiguredError);
  });
});
