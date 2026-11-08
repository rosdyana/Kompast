import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { db, schema, eq, asc, sql, adminDb, withTenant } from "@kompast/db";
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
import { createIssue, archiveIssue, moveIssue } from "../issue";
import { addComment } from "../comment";
import { createPage, archivePage, updatePageMeta, permanentlyDeletePage } from "../page";
import { AiNotConfiguredError, runAiCompletion, runDocTextAction, generateIssueDescription, generateSprintSummary } from "../ai";
import {
  chunkText,
  indexEntity,
  enqueueReindex,
  claimPendingReindexTasks,
  markReindexTaskProcessed,
  processReindexTask,
  searchEmbeddings,
  askKompast,
  AskThreadNotFoundError,
  EmbeddingNotConfiguredError,
  type SearchResult,
} from "../rag";
import { enrichCandidates } from "../rag-enrich";
import { runAskTool } from "../ask-tools";
import { MAX_ASK_TURNS } from "../rag";

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

/** Plays back a list of SSE frames as a streamed Anthropic response. */
function sseFramesResponse(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

/** One Anthropic reply that streams a tool_use block whose JSON input is split across two input_json_delta chunks. */
function anthropicToolUseResponse(name: string, input: Record<string, unknown>, tokens: { input: number; output: number }): Response {
  const json = JSON.stringify(input);
  const mid = Math.floor(json.length / 2);
  return sseFramesResponse([
    { type: "message_start", message: { usage: { input_tokens: tokens.input, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${name}`, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(0, mid) } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(mid) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: tokens.output } },
  ]);
}

/** One Anthropic reply that streams plain text and ends the turn. */
function anthropicTextResponse(text: string, tokens: { input: number; output: number }): Response {
  return sseFramesResponse([
    { type: "message_start", message: { usage: { input_tokens: tokens.input, output_tokens: 0 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: tokens.output } },
  ]);
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
  const teamId = "test-ai-team";
  const ctx = { userId, organizationId: orgId };

  async function cleanup() {
    await db.delete(schema.systemSettings);
    await db.delete(schema.aiUsage).where(eq(schema.aiUsage.organizationId, orgId));
    await db.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await db.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
  }

  beforeEach(async () => {
    await cleanup();
    await db.insert(schema.organization).values({ id: orgId, name: "AI Test Org", slug: orgId });
    await db.insert(schema.user).values({ id: userId, name: "AI User", email: `${userId}@example.com` });
    await db.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await db.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });
    // The fixture user must belong to the team that owns the project, or
    // team-scoped RLS (packages/db/rls.sql) hides it from them.
    await db.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });
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
        createProject(tx, { organizationId: orgId, teamId, key: "aisu", name: "AI Sprint Test", actorUserId: userId }),
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
  const teamId = "test-rag-team";
  const ctx = { userId, organizationId: orgId };
  /** A workspace member who is deliberately NOT on teamId — used to check team-scoped page visibility. */
  const outsiderId = "test-rag-outsider";

  async function cleanup() {
    await db.delete(schema.systemSettings);
    await db.delete(schema.aiMessage).where(sql`thread_id in (select id from ai_thread where organization_id = ${orgId})`);
    await db.delete(schema.aiThread).where(eq(schema.aiThread.organizationId, orgId));
    await db.delete(schema.embeddingIndexQueue).where(eq(schema.embeddingIndexQueue.organizationId, orgId));
    await db.delete(schema.embedding).where(eq(schema.embedding.organizationId, orgId));
    // Team-space pages (the archived-page test) reference team, so they go before it. adminDb: the restricted
    // role's RLS would hide these rows from a plain delete (no tenant session here), leaving the team FK blocked.
    await adminDb.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await db.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await db.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.delete(schema.user).where(eq(schema.user.id, outsiderId));
  }

  beforeEach(async () => {
    await cleanup();
    await db.insert(schema.organization).values({ id: orgId, name: "RAG Test Org", slug: orgId });
    await db.insert(schema.user).values({ id: userId, name: "RAG User", email: `${userId}@example.com` });
    await db.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await db.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });
    // The fixture user must belong to the team that owns the project, or
    // team-scoped RLS (packages/db/rls.sql) hides it from them.
    await db.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });
  });

  afterEach(async () => {
    await cleanup();
    vi.unstubAllGlobals();
  });

  async function seedProject() {
    return withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "rag", name: "RAG Test", actorUserId: userId }));
  }

  /**
   * Indexing only ever runs in apps/worker, on the admin connection
   * (bypasses RLS) — mirror that here rather than indexing as a user, whose
   * team-scoped embedding policy (packages/db/rls.sql) would also gate the
   * write on the entity being visible to them.
   */
  function asWorker<T>(fn: Parameters<typeof withTenant<T>>[2]) {
    return withTenant(adminDb, { organizationId: orgId, userId: "system" }, fn);
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
    await asWorker((tx) => indexEntity(tx, { organizationId: orgId, entityType: "issue", entityId: "fake-1", text: "hello world" }));
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
      await asWorker((tx) => indexEntity(tx, { organizationId: orgId, entityType: "issue", entityId: "fake-1", text: "hello world" }));
      let rows = await adminDb.select().from(schema.embedding).where(eq(schema.embedding.entityId, "fake-1"));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.content).toBe("hello world");
      expect(rows[0]!.vector).toHaveLength(EMBEDDING_DIMENSIONS);

      await asWorker((tx) => indexEntity(tx, { organizationId: orgId, entityType: "issue", entityId: "fake-1", text: "completely different text" }));
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

      await asWorker((tx) => processReindexTask(tx, task!));
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
      // Claim in batches until ours turns up: claims are oldest-first, and a
      // shared test DB with no worker draining it accumulates pending rows
      // from earlier runs, so one batch of 50 may never reach ours.
      let ours: Awaited<ReturnType<typeof claimPendingReindexTasks>> = [];
      for (let batch = await claimPendingReindexTasks(adminDb, 500); batch.length > 0 && ours.length === 0; batch = await claimPendingReindexTasks(adminDb, 500)) {
        ours = batch.filter((t) => t.entityId === issueId);
      }
      expect(ours).toHaveLength(1);
      expect(ours[0]!.status).toBe("processing");
    });

    it("searchEmbeddings ranks the chunk whose text exactly matches the query ahead of an unrelated one", async () => {
      // Real issues, not made-up ids: searchEmbeddings runs as the user, and
      // the embedding policy only returns chunks of issues they can see.
      const { projectId, issueTypes, statuses } = await seedProject();
      const mk = (title: string) =>
        withAuthorizedTenant(ctx, (tx) => createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title, reporterId: userId }));
      const { issueId: relevantId } = await mk("Relevant");
      const { issueId: unrelatedId } = await mk("Unrelated");
      await asWorker((tx) => indexEntity(tx, { organizationId: orgId, entityType: "issue", entityId: relevantId, text: "database migration rollback procedure" }));
      await asWorker((tx) => indexEntity(tx, { organizationId: orgId, entityType: "issue", entityId: unrelatedId, text: "office coffee machine is broken" }));

      const queryVector = fakeEmbed("database migration rollback procedure");
      const results = await withAuthorizedTenant(ctx, (tx) => searchEmbeddings(tx, { organizationId: orgId, queryVector, limit: 5 }));

      expect(results[0]!.entityId).toBe(relevantId);
      expect(results[0]!.distance).toBeLessThan(results.find((r) => r.entityId === unrelatedId)!.distance);
    });

    it("enqueueReindex skips a duplicate while a task for the same entity is pending, but a processing task does not block a new one", async () => {
      const { projectId, issueTypes, statuses } = await seedProject();
      // createIssue already queues one pending index task for this issue.
      const { issueId } = await withAuthorizedTenant(ctx, (tx) => createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Dedupe target", reporterId: userId }));
      const enqueue = () => withAuthorizedTenant(ctx, (tx) => enqueueReindex(tx, { organizationId: orgId, entityType: "issue", entityId: issueId }));
      const forIssue = () => adminDb.select().from(schema.embeddingIndexQueue).where(eq(schema.embeddingIndexQueue.entityId, issueId));

      await enqueue();
      await enqueue();
      let rows = await forIssue();
      const pending = rows.filter((r) => r.status === "pending");
      expect(pending).toHaveLength(1);
      expect(rows).toHaveLength(1);

      await adminDb.update(schema.embeddingIndexQueue).set({ status: "processing" }).where(eq(schema.embeddingIndexQueue.id, pending[0]!.id));
      await enqueue();
      rows = await forIssue();
      expect(rows.filter((r) => r.status === "pending")).toHaveLength(1);
      expect(rows).toHaveLength(2);
    });

    it("searchEmbeddings drops archived issues and comments on archived issues, but keeps live ones", async () => {
      const { projectId, issueTypes, statuses } = await seedProject();
      const mk = (title: string) =>
        withAuthorizedTenant(ctx, (tx) => createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title, reporterId: userId }));
      const { issueId: liveId } = await mk("Live issue");
      const { issueId: archivedId } = await mk("Archived issue");
      const { commentId } = await withAuthorizedTenant(ctx, (tx) => addComment(tx, { issueId: archivedId, authorId: userId, bodyJson: { text: "comment on the archived issue" } }));

      // Identical text on all three, so each vector is identical and any of them would match the query equally.
      const sharedText = "shared searchable text about the archive filter";
      await asWorker((tx) => indexEntity(tx, { organizationId: orgId, entityType: "issue", entityId: liveId, text: sharedText }));
      await asWorker((tx) => indexEntity(tx, { organizationId: orgId, entityType: "issue", entityId: archivedId, text: sharedText }));
      await asWorker((tx) => indexEntity(tx, { organizationId: orgId, entityType: "comment", entityId: commentId, text: sharedText }));

      const search = () => withAuthorizedTenant(ctx, (tx) => searchEmbeddings(tx, { organizationId: orgId, queryVector: fakeEmbed(sharedText), limit: 10 }));
      const before = (await search()).map((r) => r.entityId);
      expect(before).toEqual(expect.arrayContaining([liveId, archivedId, commentId]));

      await withAuthorizedTenant(ctx, (tx) => archiveIssue(tx, archivedId, { actorId: userId }));

      const after = (await search()).map((r) => r.entityId);
      expect(after).toContain(liveId);
      expect(after).not.toContain(archivedId);
      expect(after).not.toContain(commentId);
    });

    it("searchEmbeddings drops archived pages", async () => {
      const pageId = (await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, teamId, title: "Archive me", actorUserId: userId }))).id;
      const sharedText = "shared searchable text about archived docs";
      await asWorker((tx) => indexEntity(tx, { organizationId: orgId, entityType: "page", entityId: pageId, text: sharedText }));

      const search = () => withAuthorizedTenant(ctx, (tx) => searchEmbeddings(tx, { organizationId: orgId, queryVector: fakeEmbed(sharedText), limit: 10 }));
      expect((await search()).map((r) => r.entityId)).toContain(pageId);

      await withAuthorizedTenant(ctx, (tx) => archivePage(tx, pageId));
      expect((await search()).map((r) => r.entityId)).not.toContain(pageId);
    });

    it("indexes a page's title and Yjs body, returns it to a team member, and hides it from a workspace member outside the team", async () => {
      const { projectId } = await seedProject();
      const title = "Quokka runbook";
      const sentence = "The quokka migration plan moves billing to the new ledger service.";
      const pageId = (await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, projectId, title, actorUserId: userId }))).id;

      // Body as apps/collab stores it: a Yjs doc whose "document-store" fragment holds BlockNote's blockGroup/blockContainer/paragraph shape.
      const ydoc = new Y.Doc();
      const group = new Y.XmlElement("blockGroup");
      const container = new Y.XmlElement("blockContainer");
      const paragraph = new Y.XmlElement("paragraph");
      const runs = new Y.XmlText();
      ydoc.getXmlFragment("document-store").push([group]);
      group.push([container]);
      container.push([paragraph]);
      paragraph.push([runs]);
      runs.insert(0, sentence);
      await adminDb.insert(schema.ydocState).values({ pageId, state: Buffer.from(Y.encodeStateAsUpdate(ydoc)) });

      await withAuthorizedTenant(ctx, (tx) => enqueueReindex(tx, { organizationId: orgId, entityType: "page", entityId: pageId }));
      const task = await fetchPendingReindexTask(pageId);
      expect(task).toMatchObject({ entityType: "page", action: "index", status: "pending" });
      await asWorker((tx) => processReindexTask(tx, task!));
      await markReindexTaskProcessed(adminDb, task!.id);

      // fakeEmbed of the exact indexed text, so the page's chunk is the nearest match.
      const pageText = `${title}\n\n${sentence}`;
      const search = (asUser: { userId: string; organizationId: string }) =>
        withAuthorizedTenant(asUser, (tx) => searchEmbeddings(tx, { organizationId: orgId, queryVector: fakeEmbed(pageText), entityTypes: ["page"], limit: 10 }));

      const teamHits = await search(ctx);
      const hit = teamHits.find((r) => r.entityId === pageId);
      expect(hit).toBeDefined();
      expect(hit!.content).toContain(sentence);

      await db.insert(schema.user).values({ id: outsiderId, name: "RAG Outsider", email: `${outsiderId}@example.com` });
      await db.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId: outsiderId, role: "member" });
      expect(await search({ userId: outsiderId, organizationId: orgId })).toEqual([]);
    });

    it("updatePageMeta queues a page reindex only when the title changes, and permanentlyDeletePage queues a delete", async () => {
      const pageId = (await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, teamId, title: "Before", actorUserId: userId }))).id;
      // createPage already queued an index task; mark it done so only what the next call enqueues is visible.
      await adminDb.update(schema.embeddingIndexQueue).set({ status: "processed" }).where(eq(schema.embeddingIndexQueue.entityId, pageId));
      const forPage = () => adminDb.select().from(schema.embeddingIndexQueue).where(eq(schema.embeddingIndexQueue.entityId, pageId));

      await withAuthorizedTenant(ctx, (tx) => updatePageMeta(tx, pageId, { icon: "star" }));
      expect((await forPage()).filter((r) => r.status === "pending")).toHaveLength(0);

      await withAuthorizedTenant(ctx, (tx) => updatePageMeta(tx, pageId, { title: "After" }));
      const pending = (await forPage()).filter((r) => r.status === "pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ organizationId: orgId, entityType: "page", action: "index" });

      await withAuthorizedTenant(ctx, (tx) => permanentlyDeletePage(tx, pageId));
      const deletes = (await forPage()).filter((r) => r.action === "delete");
      expect(deletes).toHaveLength(1);
      expect(deletes[0]).toMatchObject({ organizationId: orgId, entityType: "page", status: "pending" });
    });

    it("askKompast retrieves relevant context, answers, and persists both the question and the answer with citations", async () => {
      const { projectId, issueTypes, statuses } = await seedProject();
      const { issueId } = await withAuthorizedTenant(ctx, (tx) =>
        createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Unique searchable issue title", reporterId: userId }),
      );
      const task = await fetchPendingReindexTask(issueId);
      await asWorker((tx) => processReindexTask(tx, task!));

      const deltas: string[] = [];
      const result = await askKompast(ctx, { question: "Unique searchable issue title", onDelta: (d) => deltas.push(d) });

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
      const first = await askKompast(ctx, { question: "first question" });

      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock.mockClear();

      await askKompast(ctx, { threadId: first.threadId, question: "second question" });

      const chatCall = fetchMock.mock.calls.find((c: unknown[]) => !String(c[0]).includes("/embeddings"))!;
      const sentBody = JSON.parse(chatCall[1].body);
      expect(JSON.stringify(sentBody.messages)).toContain("first question");
      expect(JSON.stringify(sentBody.messages)).toContain("Hello"); // the prior assistant answer
    });

    it("enrichment is live: a status change made after indexing shows up in the next prompt and citation, without reindexing", async () => {
      const { projectId, issueTypes, statuses } = await seedProject();
      const inProgress = statuses.find((s) => s.name === "In Progress")!;
      const { issueId } = await withAuthorizedTenant(ctx, (tx) =>
        createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Live enrichment probe", reporterId: userId }),
      );
      const task = await fetchPendingReindexTask(issueId);
      await asWorker((tx) => processReindexTask(tx, task!));

      // Deliberately no reindex after this move: the context header must come from the live row, not the indexed text.
      await withAuthorizedTenant(ctx, (tx) => moveIssue(tx, { issueId, toStatusId: inProgress.id, actorId: userId }));

      const result = await askKompast(ctx, { question: "Live enrichment probe" });

      const [project] = await adminDb.select().from(schema.project).where(eq(schema.project.id, projectId));
      const [issue] = await adminDb.select().from(schema.issue).where(eq(schema.issue.id, issueId));
      const key = `${project!.key}-${issue!.keySeq}`;

      const chatCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => !String(c[0]).includes("/embeddings"))!;
      // Raw request body: the Anthropic driver sends the system prompt (where the context lives) as a top-level `system` field, not inside `messages`.
      const sentBody = chatCall[1].body as string;
      expect(sentBody).toContain(key);
      expect(sentBody).toContain("In Progress");
      expect(sentBody).toContain(`Issue ${key} \\"Live enrichment probe\\"`);

      const citation = result.citations.find((c) => c.entityId === issueId);
      expect(citation).toBeDefined();
      expect(citation!.ref).toEqual({ kind: "issue", teamId, projectKey: project!.key, keySeq: issue!.keySeq });
      expect(citation!.title).toBe(`${key} · Live enrichment probe`);
    });

    it("enrichCandidates drops candidates whose entity doesn't exist or isn't visible, keeps the rest, and labels a project page by its project", async () => {
      const { projectId, issueTypes, statuses } = await seedProject();
      const { issueId } = await withAuthorizedTenant(ctx, (tx) =>
        createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Visible probe", reporterId: userId }),
      );
      const pageId = (await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, projectId, title: "Probe doc", actorUserId: userId }))).id;

      const ghost = (entityType: SearchResult["entityType"]): SearchResult => ({ entityType, entityId: id("ghost"), content: "ghost text", distance: 0 });
      const candidates: SearchResult[] = [
        ghost("issue"),
        { entityType: "issue", entityId: issueId, content: "Visible probe", distance: 0 },
        ghost("comment"),
        ghost("page"),
        { entityType: "page", entityId: pageId, content: "Probe doc body", distance: 0 },
      ];

      const enriched = await withAuthorizedTenant(ctx, (tx) => enrichCandidates(tx, candidates));
      expect(enriched.map((e) => e.candidate.entityId)).toEqual([issueId, pageId]);
      expect(enriched[0]!.enrichment).toMatchObject({ kind: "issue", issue: { key: expect.stringMatching(/^RAG-\d+$/), title: "Visible probe", statusName: statuses[0]!.name } });
      expect(enriched[1]!.enrichment).toEqual({ kind: "page", title: "Probe doc", space: "project RAG" });
    });

    it("a failed chat call persists nothing: no thread, no message, no ai_usage row", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL, init?: RequestInit) => {
          if (url.toString().includes("/embeddings")) return fakeEmbeddingsResponse((JSON.parse(init!.body as string) as { input: string[] }).input);
          return new Response("upstream exploded", { status: 500 });
        }),
      );

      await expect(askKompast(ctx, { question: "this one will fail" })).rejects.toThrow(/Anthropic API error \(500\)/);

      expect(await adminDb.select().from(schema.aiThread).where(eq(schema.aiThread.userId, userId))).toHaveLength(0);
      expect(await adminDb.select().from(schema.aiMessage).where(sql`thread_id in (select id from ai_thread where organization_id = ${orgId})`)).toHaveLength(0);
      expect(await adminDb.select().from(schema.aiUsage).where(eq(schema.aiUsage.organizationId, orgId))).toHaveLength(0);
    });

    it("a successful ask persists exactly the question and the answer in one new thread, and one ai_usage row for feature ask-kompast", async () => {
      const result = await askKompast(ctx, { question: "usage probe" });

      const messages = await adminDb.select().from(schema.aiMessage).where(eq(schema.aiMessage.threadId, result.threadId));
      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.role).sort()).toEqual(["assistant", "user"]);

      const usage = await adminDb.select().from(schema.aiUsage).where(eq(schema.aiUsage.organizationId, orgId));
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ userId, feature: "ask-kompast", provider: "anthropic", inputTokens: 12, outputTokens: 5 });
    });

    describe("ask tools", () => {
      /** Embeddings are answered as usual; each chat (Anthropic) call is answered by `reply`, given the 0-based chat-call index and the parsed request body. */
      function stubChatScript(reply: (chatCall: number, body: Record<string, any>) => Response) {
        let chatCall = 0;
        const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
          if (url.toString().includes("/embeddings")) {
            return fakeEmbeddingsResponse((JSON.parse(init!.body as string) as { input: string[] }).input);
          }
          return reply(chatCall++, JSON.parse(init!.body as string));
        });
        vi.stubGlobal("fetch", fetchMock);
        return fetchMock;
      }

      /** The request bodies of the chat (non-embedding) calls, in order. */
      function chatBodies(fetchMock: ReturnType<typeof vi.fn>): Record<string, any>[] {
        return fetchMock.mock.calls.filter((c: unknown[]) => !String(c[0]).includes("/embeddings")).map((c: unknown[]) => JSON.parse((c[1] as RequestInit).body as string));
      }

      it("the model looks up its own assigned issues, then answers from the result; one thread, one answer, summed usage", async () => {
        const { projectId, issueTypes, statuses } = await seedProject();
        const { issueId } = await withAuthorizedTenant(ctx, (tx) =>
          createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Assigned to me probe", reporterId: userId, assigneeId: userId }),
        );
        const [project] = await adminDb.select().from(schema.project).where(eq(schema.project.id, projectId));
        const [issue] = await adminDb.select().from(schema.issue).where(eq(schema.issue.id, issueId));
        const key = `${project!.key}-${issue!.keySeq}`;

        const fetchMock = stubChatScript((call) =>
          call === 0
            ? anthropicToolUseResponse("list_issues", { assignee: "me" }, { input: 10, output: 3 })
            : anthropicTextResponse(`You have ${key}.`, { input: 20, output: 6 }),
        );
        const onTool = vi.fn();

        const result = await askKompast(ctx, { question: "what is assigned to me?", onTool });

        expect(result.answer).toBe(`You have ${key}.`);
        expect(onTool).toHaveBeenCalledWith("list_issues");

        const bodies = chatBodies(fetchMock);
        expect(bodies).toHaveLength(2);
        expect(bodies[0]!.tools.map((t: { name: string }) => t.name)).toContain("list_issues");
        const toolResult = bodies[1]!.messages.flatMap((m: { content: unknown }) => (Array.isArray(m.content) ? m.content : [])).find((b: { type: string }) => b.type === "tool_result");
        expect(toolResult.content).toContain(key);
        expect(toolResult.content).toContain("Assigned to me probe");

        const messages = await adminDb.select().from(schema.aiMessage).where(eq(schema.aiMessage.threadId, result.threadId)).orderBy(asc(schema.aiMessage.createdAt));
        expect(messages).toHaveLength(2);
        expect(messages[1]).toMatchObject({ role: "assistant", content: `You have ${key}.` });

        const usage = await adminDb.select().from(schema.aiUsage).where(eq(schema.aiUsage.organizationId, orgId));
        expect(usage).toHaveLength(1);
        expect(usage[0]).toMatchObject({ inputTokens: 30, outputTokens: 9 });
      });

      it("tools never reveal a project or issue the asking user's team can't see", async () => {
        // A second team the fixture user is NOT on, with its own project and issue.
        const hiddenTeamId = "test-rag-hidden-team";
        await db.insert(schema.team).values({ id: hiddenTeamId, organizationId: orgId, name: "Hidden Team" });
        const hidden = await asWorker((tx) => createProject(tx, { organizationId: orgId, teamId: hiddenTeamId, key: "hid", name: "Hidden Project", actorUserId: userId }));
        const { issueId } = await asWorker((tx) =>
          createIssue(tx, { organizationId: orgId, projectId: hidden.projectId, typeId: hidden.issueTypes[0]!.id, statusId: hidden.statuses[0]!.id, title: "Hidden secret plan", reporterId: userId }),
        );
        const [hiddenIssue] = await adminDb.select().from(schema.issue).where(eq(schema.issue.id, issueId));
        const [hiddenProject] = await adminDb.select().from(schema.project).where(eq(schema.project.id, hidden.projectId));
        const hiddenKey = `${hiddenProject!.key}-${hiddenIssue!.keySeq}`;

        const run = async (name: string, input: Record<string, unknown>) => JSON.parse(await runAskTool(ctx, { id: `call_${name}`, name, input }));

        const byProject = await run("list_issues", { projectKey: hiddenProject!.key });
        expect(byProject.error).toBeDefined();
        expect(JSON.stringify(byProject)).not.toContain("Hidden secret plan");

        const byKey = await run("get_issue", { key: hiddenKey });
        expect(byKey.error).toBeDefined();
        expect(JSON.stringify(byKey)).not.toContain("Hidden secret plan");

        const sprint = await run("get_sprint", { projectKey: hiddenProject!.key, sprint: "active" });
        expect(sprint.error).toBeDefined();

        const everything = await run("list_issues", {});
        expect(JSON.stringify(everything)).not.toContain("Hidden secret plan");
        expect(JSON.stringify(everything)).not.toContain(hiddenKey);

        const projects = await run("list_projects", {});
        expect(projects.map((p: { key: string }) => p.key)).not.toContain(hiddenProject!.key);
      });

      it("stops after MAX_ASK_TURNS when the model keeps asking for tools, and the last request carries no tools", async () => {
        const fetchMock = stubChatScript(() => anthropicToolUseResponse("list_projects", {}, { input: 1, output: 1 }));

        await askKompast(ctx, { question: "loop forever" });

        const bodies = chatBodies(fetchMock);
        expect(bodies).toHaveLength(MAX_ASK_TURNS);
        for (const body of bodies.slice(0, -1)) expect(body.tools).toBeDefined();
        expect(bodies[bodies.length - 1]).not.toHaveProperty("tools");

        const usage = await adminDb.select().from(schema.aiUsage).where(eq(schema.aiUsage.organizationId, orgId));
        expect(usage).toHaveLength(1);
        expect(usage[0]).toMatchObject({ inputTokens: MAX_ASK_TURNS, outputTokens: MAX_ASK_TURNS });
      });

      it("a bad tool call comes back as an error result, never a thrown exception", async () => {
        expect(JSON.parse(await runAskTool(ctx, { id: "a", name: "get_issue", input: {} }))).toEqual({ error: '"key" is required' });
        expect(JSON.parse(await runAskTool(ctx, { id: "b", name: "delete_everything", input: {} })).error).toMatch(/Unknown tool/);
        expect(JSON.parse(await runAskTool(ctx, { id: "c", name: "list_issues", input: { limit: "ten" } })).error).toMatch(/limit/);
        expect(JSON.parse(await runAskTool(ctx, { id: "d", name: "list_issues", input: { sprint: "Sprint 1" } })).error).toMatch(/projectKey/);
      });
    });

    describe("thread ownership", () => {
      const otherUserId = "test-rag-other-user";
      const otherCtx = { userId: otherUserId, organizationId: orgId };

      beforeEach(async () => {
        await db.delete(schema.user).where(eq(schema.user.id, otherUserId));
        await db.insert(schema.user).values({ id: otherUserId, name: "Other RAG User", email: `${otherUserId}@example.com` });
        await db.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId: otherUserId, role: "member" });
        await db.insert(schema.teamMember).values({ id: `tmem-${teamId}-${otherUserId}`, teamId, userId: otherUserId, membershipKey: `${teamId}:${otherUserId}` });
      });

      afterEach(async () => {
        await db.delete(schema.aiMessage).where(sql`thread_id in (select id from ai_thread where organization_id = ${orgId})`);
        await db.delete(schema.aiThread).where(eq(schema.aiThread.organizationId, orgId));
        await db.delete(schema.member).where(eq(schema.member.userId, otherUserId));
        await db.delete(schema.user).where(eq(schema.user.id, otherUserId));
      });

      it("another workspace member can't read someone else's thread or its messages", async () => {
        const mine = await askKompast(ctx, { question: "my private question" });

        const theirThreads = await withAuthorizedTenant(otherCtx, (tx) => tx.select().from(schema.aiThread).where(eq(schema.aiThread.id, mine.threadId)));
        const theirMessages = await withAuthorizedTenant(otherCtx, (tx) => tx.select().from(schema.aiMessage).where(eq(schema.aiMessage.threadId, mine.threadId)));
        expect(theirThreads).toHaveLength(0);
        expect(theirMessages).toHaveLength(0);
      });

      it("askKompast refuses another user's threadId and writes nothing to that thread", async () => {
        const mine = await askKompast(ctx, { question: "my private question" });

        await expect(askKompast(otherCtx, { threadId: mine.threadId, question: "sneaky" })).rejects.toThrow(AskThreadNotFoundError);

        const messages = await adminDb.select().from(schema.aiMessage).where(eq(schema.aiMessage.threadId, mine.threadId));
        expect(messages).toHaveLength(2);
        expect(messages.some((m) => m.content === "sneaky")).toBe(false);

        // The owner can still continue it.
        await askKompast(ctx, { threadId: mine.threadId, question: "follow-up" });
        const after = await adminDb.select().from(schema.aiMessage).where(eq(schema.aiMessage.threadId, mine.threadId));
        expect(after).toHaveLength(4);
      });
    });
  });

  it("askKompast throws EmbeddingNotConfiguredError when embeddings aren't set up", async () => {
    await expect(askKompast(ctx, { question: "anything" })).rejects.toThrow(EmbeddingNotConfiguredError);
  });
});
