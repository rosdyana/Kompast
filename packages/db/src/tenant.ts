import { sql } from "drizzle-orm";
import type { db as Db } from "./index";

/**
 * The single enforcement point for tenant isolation. Every query in the
 * codebase — UI server functions, REST handlers, MCP tools, worker jobs —
 * MUST go through this wrapper. It sets Postgres session GUCs that the
 * per-table RLS policies (packages/db/drizzle/*_rls.sql) read; a query
 * issued outside of it runs with no workspace scoping at all.
 *
 * This has its own test suite (see plan §Verification, "Tenant isolation")
 * because it is the one place a bug leaks data across workspaces.
 */
export async function withTenant<T>(
  db: typeof Db,
  ctx: { organizationId: string; userId: string | null },
  fn: (tx: Parameters<Parameters<typeof Db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.current_workspace', ${ctx.organizationId}, true)`,
    );
    await tx.execute(
      sql`select set_config('app.current_user', ${ctx.userId ?? ""}, true)`,
    );
    return fn(tx);
  });
}
