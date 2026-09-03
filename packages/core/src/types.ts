import type { db as Db } from "@kompast/db";

/** The transaction client every service function receives — never the top-level `db`. */
export type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

/**
 * Anything queryable the same way: either the top-level `db` (has its own
 * `.transaction()`) or a `Tx` already inside one (doesn't). Functions that
 * only read/write rows and don't need to open their own transaction accept
 * this instead of `Tx`, so they compose whether called standalone or from
 * inside another service's transaction.
 */
export type AnyDb = typeof Db | Tx;
