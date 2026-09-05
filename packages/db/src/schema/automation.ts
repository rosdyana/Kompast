import { pgTable, text, boolean, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { project } from "./project";
import type { Json } from "./_shared";

/**
 * `trigger`/`conditions`/`actions` are jsonb rather than normalized tables
 * — a rule's shape varies enough by trigger/action type (see
 * packages/core/src/automation.ts's RuleTrigger/RuleCondition/RuleAction
 * unions) that a fixed relational schema would mean a migration per new
 * action type. `conditions` is an array, ANDed together (no OR/nesting —
 * the plan's "JQL-lite expression" condition type is a documented scope
 * cut for this pass, not built).
 */
export const automationRule = pgTable(
  "automation_rule",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Actions are evaluated but never applied — automation_run still gets written, marked "dry_run". Safe way to test a new rule. */
    dryRun: boolean("dry_run").notNull().default(false),
    trigger: jsonb("trigger").$type<Json>().notNull(),
    conditions: jsonb("conditions").$type<Json>().notNull().default([]),
    actions: jsonb("actions").$type<Json>().notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("automation_rule_project_idx").on(t.projectId), index("automation_rule_org_idx").on(t.organizationId)],
);

/** One row per rule the engine evaluated for a given event — including rules that didn't match, for a debuggable audit trail. */
export const automationRun = pgTable(
  "automation_run",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    ruleId: text("rule_id")
      .notNull()
      .references(() => automationRule.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    status: text("status", { enum: ["matched", "not_matched", "dry_run", "skipped_rate_limited", "skipped_max_depth", "failed"] }).notNull(),
    input: jsonb("input").$type<Json>().notNull(),
    actionsRun: jsonb("actions_run").$type<Json>(),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("automation_run_rule_idx").on(t.ruleId)],
);

/**
 * Transactional outbox for domain events (same pattern as email_outbox —
 * see packages/db/src/schema/notification.ts). emitAutomationEvent()
 * (packages/core/src/automation.ts) writes a row in the SAME transaction
 * as the mutation that caused it; apps/worker's automation queue claims
 * pending rows the same FOR UPDATE SKIP LOCKED way the mail queue does.
 * `depth` and `causedByRuleId` are how the two loop-prevention guardrails
 * work: a rule is never evaluated against an event its OWN action caused
 * (causedByRuleId), and any event past depth 5 is skipped entirely,
 * regardless of which rule — a chain of DIFFERENT rules triggering each
 * other is allowed up to that depth, not just direct self-loops.
 */
export const automationEvent = pgTable(
  "automation_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    entityType: text("entity_type", { enum: ["issue"] }).notNull(),
    entityId: text("entity_id").notNull(),
    payload: jsonb("payload").$type<Json>().notNull(),
    depth: integer("depth").notNull().default(0),
    causedByRuleId: text("caused_by_rule_id").references(() => automationRule.id, { onDelete: "set null" }),
    status: text("status", { enum: ["pending", "processing", "processed", "failed"] }).notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("automation_event_status_idx").on(t.status), index("automation_event_project_idx").on(t.projectId)],
);
