import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { withIdempotency, IdempotencyInProgressError } from "../idempotency";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("idempotency", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-idem-org";
  const userId = "test-idem-user";

  async function cleanup() {
    await admin.delete(schema.idempotencyKey).where(eq(schema.idempotencyKey.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Idem Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  it("runs fn exactly once for a given key, replaying the stored response on retry", async () => {
    const ctx = { userId, organizationId: orgId };
    let calls = 0;

    const first = await withAuthorizedTenant(ctx, (tx) =>
      withIdempotency(tx, orgId, "create_issue", "client-key-1", async () => {
        calls++;
        return { issueId: "issue_abc" };
      }),
    );
    expect(first.replayed).toBe(false);
    expect(first.response).toEqual({ issueId: "issue_abc" });

    const second = await withAuthorizedTenant(ctx, (tx) =>
      withIdempotency(tx, orgId, "create_issue", "client-key-1", async () => {
        calls++;
        return { issueId: "issue_should_not_happen" };
      }),
    );
    expect(second.replayed).toBe(true);
    expect(second.response).toEqual({ issueId: "issue_abc" });
    expect(calls).toBe(1);
  });

  it("scopes keys per endpoint — the same key string is independent across endpoints", async () => {
    const ctx = { userId, organizationId: orgId };

    const issueResult = await withAuthorizedTenant(ctx, (tx) =>
      withIdempotency(tx, orgId, "create_issue", "shared-key", async () => ({ kind: "issue" })),
    );
    const pageResult = await withAuthorizedTenant(ctx, (tx) =>
      withIdempotency(tx, orgId, "create_page", "shared-key", async () => ({ kind: "page" })),
    );

    expect(issueResult.replayed).toBe(false);
    expect(pageResult.replayed).toBe(false);
    expect(issueResult.response).toEqual({ kind: "issue" });
    expect(pageResult.response).toEqual({ kind: "page" });
  });

  it("a failed mutation rolls back the claim, leaving the key retryable", async () => {
    const ctx = { userId, organizationId: orgId };

    await expect(
      withAuthorizedTenant(ctx, (tx) =>
        withIdempotency(tx, orgId, "create_issue", "retry-key", async () => {
          throw new Error("boom");
        }),
      ),
    ).rejects.toThrow("boom");

    const retried = await withAuthorizedTenant(ctx, (tx) =>
      withIdempotency(tx, orgId, "create_issue", "retry-key", async () => ({ ok: true })),
    );
    expect(retried.replayed).toBe(false);
    expect(retried.response).toEqual({ ok: true });
  });

  it("a concurrent in-flight claim (no committed response yet) surfaces as IdempotencyInProgressError", async () => {
    const ctx = { userId, organizationId: orgId };

    // Simulate a request that claimed the key but hasn't committed a response yet.
    await admin.insert(schema.idempotencyKey).values({
      id: id("idem"),
      organizationId: orgId,
      endpoint: "create_issue",
      key: "in-flight-key",
      responseJson: null,
    });

    await expect(
      withAuthorizedTenant(ctx, (tx) =>
        withIdempotency(tx, orgId, "create_issue", "in-flight-key", async () => ({ ok: true })),
      ),
    ).rejects.toThrow(IdempotencyInProgressError);
  });
});
