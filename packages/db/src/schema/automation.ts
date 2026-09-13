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

export const automationWorkflowNodeType = [
  "trigger_event",
  "trigger_schedule",
  "condition_property",
  "action_set_property",
  "action_add_label",
  "action_comment",
  "action_notify",
  "action_link_issue",
  "action_create_subtask",
  "action_webhook",
  "delay",
] as const;

/**
 * The new node-graph automation engine — built alongside automation_rule/
 * automation_run/automation_event (untouched, still live for the old
 * engine/UI) rather than replacing them in place. See
 * docs/superpowers/specs/2026-09-13-automation-node-workflows-design.md's
 * "Rollout sequencing" for why these tables have distinct names even where
 * they'd otherwise collide with an old one (automation_run in particular).
 */
export const automationWorkflow = pgTable(
  "automation_workflow",
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
    dryRun: boolean("dry_run").notNull().default(false),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("automation_workflow_project_idx").on(t.projectId), index("automation_workflow_org_idx").on(t.organizationId)],
);

/** The trigger is just another node type (no incoming edges) — see the spec's "Node types" section. */
export const automationNode = pgTable(
  "automation_node",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => automationWorkflow.id, { onDelete: "cascade" }),
    type: text("type", { enum: automationWorkflowNodeType }).notNull(),
    /** Shape varies by `type` — see automation-workflow.ts's per-type zod schemas. */
    config: jsonb("config").$type<Json>().notNull().default({}),
    /** Canvas layout only — never read by the execution engine. */
    position: jsonb("position").$type<{ x: number; y: number }>().notNull().default({ x: 0, y: 0 }),
  },
  (t) => [index("automation_node_workflow_idx").on(t.workflowId)],
);

/** fromHandle is null for single-output nodes, "true"/"false" for condition_property's two outputs. */
export const automationEdge = pgTable(
  "automation_edge",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => automationWorkflow.id, { onDelete: "cascade" }),
    fromNodeId: text("from_node_id")
      .notNull()
      .references(() => automationNode.id, { onDelete: "cascade" }),
    fromHandle: text("from_handle", { enum: ["true", "false"] }),
    toNodeId: text("to_node_id")
      .notNull()
      .references(() => automationNode.id, { onDelete: "cascade" }),
  },
  (t) => [index("automation_edge_workflow_idx").on(t.workflowId), index("automation_edge_from_idx").on(t.fromNodeId)],
);

/**
 * A dedicated outbox for the new engine, same shape as automation_event —
 * NOT shared with it, because claimPendingAutomationEvents claims by
 * mutating automation_event's own `status` column; if the new engine
 * claimed from that same table it would race the old engine for the same
 * rows. emitAutomationEvent (automation-events.ts) writes to both tables
 * from the same call.
 */
export const automationWorkflowEvent = pgTable(
  "automation_workflow_event",
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
    causedByWorkflowId: text("caused_by_workflow_id").references(() => automationWorkflow.id, { onDelete: "set null" }),
    status: text("status", { enum: ["pending", "processing", "processed", "failed"] }).notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("automation_workflow_event_status_idx").on(t.status), index("automation_workflow_event_project_idx").on(t.projectId)],
);

/** One row per trigger firing (one event, or one schedule tick). */
export const automationWorkflowRun = pgTable(
  "automation_workflow_run",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => automationWorkflow.id, { onDelete: "cascade" }),
    /** The triggering issue snapshot + accumulated variables, read by downstream node executors. */
    context: jsonb("context").$type<Json>().notNull(),
    status: text("status", { enum: ["running", "completed", "failed"] }).notNull().default("running"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("automation_workflow_run_workflow_idx").on(t.workflowId)],
);

/** One row per node *visited* during a run — a fan-out run has multiple concurrently-active steps. */
export const automationWorkflowRunStep = pgTable(
  "automation_workflow_run_step",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => automationWorkflowRun.id, { onDelete: "cascade" }),
    nodeId: text("node_id")
      .notNull()
      .references(() => automationNode.id, { onDelete: "cascade" }),
    /** Root trigger step is depth 0; each subsequent step is its parent's depth + 1. Caps runaway branches at MAX_AUTOMATION_DEPTH. */
    depth: integer("depth").notNull().default(0),
    status: text("status", { enum: ["pending", "processing", "waiting", "succeeded", "failed", "skipped_max_depth"] })
      .notNull()
      .default("pending"),
    output: jsonb("output").$type<Json>(),
    error: text("error"),
    /** Set only when status = "waiting" (a delay node) — the claim query re-picks this row up once resumeAt has passed. */
    resumeAt: timestamp("resume_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("automation_workflow_run_step_run_idx").on(t.runId), index("automation_workflow_run_step_status_idx").on(t.status)],
);
