import { pgTable, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./auth";
import type { Json } from "./_shared";

/**
 * Backs Idempotency-Key support for REST + MCP create endpoints (see plan
 * §"REST API + MCP", "Idempotency": LLM clients retry on timeout, so
 * create_issue/create_page must de-dupe or one flaky call produces two
 * cards). `responseJson` is nullable, not just "empty until set": a row
 * with a null response means a request under this key is currently
 * in-flight (claimed via the unique index below, before the mutation
 * runs), which is what makes claim-then-commit race-free instead of a
 * plain check-then-insert. See packages/core/src/idempotency.ts.
 */
export const idempotencyKey = pgTable(
  "idempotency_key",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** e.g. "create_issue", "create_page" — scopes the key so two different endpoints can't collide on the same client-chosen string. */
    endpoint: text("endpoint").notNull(),
    key: text("key").notNull(),
    responseJson: jsonb("response_json").$type<Json>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("idempotency_key_uq").on(t.organizationId, t.endpoint, t.key)],
);
