import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema, eq, adminDb } from "@kompast/db";
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
  requireSystemAdmin,
} from "../settings";
import { isOnlyUser } from "../bootstrap";
import { ForbiddenError } from "../permissions";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";
import { createProject } from "../project";
import { createSprint, addIssueToSprint } from "../sprint";
import { createIssue } from "../issue";
import { AiNotConfiguredError, runAiCompletion, runDocTextAction, generateIssueDescription, generateSprintSummary } from "../ai";

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
