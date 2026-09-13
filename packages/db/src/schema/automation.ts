import { pgTable, text, boolean, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { project } from "./project";
import type { Json } from "./_shared";

export const automationWorkflowNodeType = [
  "trigger_event",
  "trigger_schedule",
  "condition_property",
  "condition_switch",
  "action_set_property",
  "action_add_label",
  "action_comment",
  "action_notify",
  "action_link_issue",
  "action_create_subtask",
  "action_webhook",
  "find_issues",
  "loop_each",
  "delay",
] as const;

/**
 * The node-graph automation engine — a graph of nodes/edges per workflow,
 * executed by a durable per-node step trail (automation_workflow_run_step
 * below). This replaced an earlier flat trigger+conditions+actions rule
 * model (automation_rule/automation_run/automation_event), which was built
 * alongside this engine for one rollout window, then migrated and dropped
 * once this engine got a real UI — see
 * docs/superpowers/specs/2026-09-13-automation-node-workflows-design.md.
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
    /** Optional human-readable key for {{steps.<name>...}} expression references — falls back to `id` when null. Must be unique within a workflow (enforced by validateGraph, not a DB constraint). */
    name: text("name"),
    /** Shape varies by `type` — see automation-workflow.ts's per-type zod schemas. */
    config: jsonb("config").$type<Json>().notNull().default({}),
    /** Canvas layout only — never read by the execution engine. */
    position: jsonb("position").$type<{ x: number; y: number }>().notNull().default({ x: 0, y: 0 }),
    /** Only meaningful for trigger_schedule nodes — when this schedule last fired, so claimDueWorkflowSchedules knows whether it's due again. */
    lastFiredAt: timestamp("last_fired_at"),
  },
  (t) => [index("automation_node_workflow_idx").on(t.workflowId)],
);

/**
 * fromHandle is free text, not a DB-level enum — null for single-output
 * nodes, "true"/"false" for condition_property's two outputs, or an
 * arbitrary case label (plus "default") for condition_switch. Validity per
 * node type is enforced by automation-workflow.ts's validateGraph, not a DB
 * constraint, since the valid set depends on the FROM node's type/config.
 */
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
    fromHandle: text("from_handle"),
    toNodeId: text("to_node_id")
      .notNull()
      .references(() => automationNode.id, { onDelete: "cascade" }),
  },
  (t) => [index("automation_edge_workflow_idx").on(t.workflowId), index("automation_edge_from_idx").on(t.fromNodeId)],
);

/**
 * Transactional outbox for domain events (same pattern as email_outbox —
 * see packages/db/src/schema/notification.ts). emitAutomationEvent()
 * (automation-events.ts) writes a row in the SAME transaction as the
 * mutation that caused it; apps/worker's workflow-event queue claims
 * pending rows the same FOR UPDATE SKIP LOCKED way the mail queue does.
 * `depth` and `causedByWorkflowId` are how the two loop-prevention
 * guardrails work: a workflow is never matched against an event its OWN
 * action caused (causedByWorkflowId), and any event past depth 5 is
 * skipped entirely, regardless of which workflow — a chain of DIFFERENT
 * workflows triggering each other is allowed up to that depth, not just
 * direct self-loops.
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
    /**
     * Stack of enclosing loop_each iterations (IterationFrame[], see
     * automation-expressions.ts), innermost last. Copied verbatim onto a
     * non-loop child step; a loop_each node instead appends one new frame
     * per item when creating ITS children. Powers both {{item}}/{{loop.*}}
     * expression resolution and issueId resolution for schedule-triggered
     * workflows looping over find_issues results (see automation-execution.ts).
     */
    iterationContext: jsonb("iteration_context").$type<Json>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("automation_workflow_run_step_run_idx").on(t.runId), index("automation_workflow_run_step_status_idx").on(t.status)],
);
