import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";

/**
 * One row per AI completion actually run — the audit trail behind the
 * plan's "Governance: per-workspace + per-feature toggles... monthly
 * token budget, ai_usage audit". `feature` is a free-form dotted string
 * (e.g. "doc.improve", "issue.description", "sprint.summary") rather than
 * an enum, so a new AI feature never needs a migration to start logging
 * usage. No cost/$ column: provider pricing changes independently of this
 * table and a stale hardcoded price is worse than no price — token counts
 * are the durable, provider-agnostic fact; cost is a derived report
 * concern for whoever owns current pricing, not stored here.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    feature: text("feature").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ai_usage_org_idx").on(t.organizationId), index("ai_usage_org_created_idx").on(t.organizationId, t.createdAt)],
);
