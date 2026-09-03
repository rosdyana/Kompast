import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { loadEnv } from "@kompast/env";

/**
 * Proves the RLS boundary actually holds when connecting as the exact role
 * the running app uses (DATABASE_URL / kompast_app), not as the migration
 * owner. This is the test that would have caught the original bug: Postgres
 * exempts superusers and table owners from RLS unconditionally, so a test
 * (or a real query) that connects as the owner "passes" even with zero
 * working isolation. See packages/db/rls.sql and bootstrap-roles.ts.
 *
 * Requires a live Postgres reachable via DATABASE_ADMIN_URL/DATABASE_URL
 * with migrations + bootstrap-roles + rls.sql already applied (`pnpm
 * --filter @kompast/db migrate`). CI should run this against a
 * testcontainers Postgres (see plan §Verification) — a fixed dev instance
 * is the pragmatic stand-in until that lands.
 */
describe("tenant isolation (RLS)", () => {
  const env = loadEnv();
  const admin = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const app = postgres(env.DATABASE_URL, { max: 1 });

  const orgA = "test-org-a";
  const orgB = "test-org-b";
  const projA = "test-proj-a";
  const projB = "test-proj-b";

  beforeAll(async () => {
    await admin`delete from project where id in (${projA}, ${projB})`;
    await admin`delete from organization where id in (${orgA}, ${orgB})`;
    await admin`
      insert into organization (id, name, slug)
      values (${orgA}, 'Test Org A', ${orgA}), (${orgB}, 'Test Org B', ${orgB})
    `;
    await admin`
      insert into project (id, organization_id, key, name)
      values (${projA}, ${orgA}, 'TSA', 'Test A'), (${projB}, ${orgB}, 'TSB', 'Test B')
    `;
  });

  afterAll(async () => {
    await admin`delete from project where id in (${projA}, ${projB})`;
    await admin`delete from organization where id in (${orgA}, ${orgB})`;
    await admin.end();
    await app.end();
  });

  /**
   * Runs `fn` against one reserved connection with the workspace GUC set
   * first — matching how packages/db/src/tenant.ts's withTenant() scopes
   * real requests inside a single transaction/connection, since GUCs set
   * via set_config() only last for the connection/transaction they're set
   * on.
   */
  async function withScopedConnection<T>(
    workspaceId: string | null,
    fn: (conn: postgres.ReservedSql) => Promise<T>,
  ): Promise<T> {
    const conn = await app.reserve();
    try {
      await conn`select set_config('app.current_workspace', ${workspaceId ?? ""}, false)`;
      return await fn(conn);
    } finally {
      conn.release();
    }
  }

  it("denies reads with no workspace GUC set (fail closed)", async () => {
    const rows = await withScopedConnection(null, (conn) =>
      conn`select id from project where id in (${projA}, ${projB})`,
    );
    expect(rows).toHaveLength(0);
  });

  it("returns only the scoped workspace's rows", async () => {
    const rows = await withScopedConnection(orgA, (conn) =>
      conn`select id from project where id in (${projA}, ${projB})`,
    );
    expect(rows.map((r) => r.id)).toEqual([projA]);
  });

  it("blocks a cross-tenant write instead of erroring or silently succeeding", async () => {
    await withScopedConnection(orgA, (conn) =>
      conn`update project set name = 'HACKED' where id = ${projB}`,
    ).catch(() => null);
    // Either the UPDATE affects 0 rows, or (depending on driver behavior)
    // throws — both are acceptable. What's NOT acceptable is the row
    // actually changing, which we verify directly via the admin connection.
    const check = await admin`select name from project where id = ${projB}`;
    expect(check[0]?.name).toBe("Test B");
  });
});
