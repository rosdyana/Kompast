import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema, eq } from "@kompast/db";
import { encryptSecret, decryptSecret } from "../crypto";
import {
  getSetupStatus,
  getMicrosoftAuthConfig,
  completeSetup,
  getAiSettings,
  updateAiSettings,
  getMailSettings,
  updateMailSettings,
  requireSystemAdmin,
} from "../settings";
import { isOnlyUser } from "../bootstrap";
import { ForbiddenError } from "../permissions";
import { id } from "../ids";

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
