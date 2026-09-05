import { and, desc, eq, gte, inArray, sql, schema, type Json } from "@kompast/db";
import type { Tx, AnyDb } from "./types";
import { id } from "./ids";
import { updateIssue, moveIssue } from "./issue";
import { addComment } from "./comment";
import { notify } from "./notification";
import { addIssueToSprint } from "./sprint";
import { linkEntities } from "./link";
import type { AutomationContext, RuleTriggerType } from "./automation-events";

export { emitAutomationEvent, type AutomationContext, type RuleTriggerType, type EmitAutomationEventInput } from "./automation-events";

export const MAX_AUTOMATION_DEPTH = 5;
const RATE_LIMIT_PER_RULE_PER_HOUR = 50;

export interface RuleCondition {
  /** Dot-free key into the event's payload — e.g. "statusId", "toStatusId", "assigneeId", "priority", "labels". */
  field: string;
  operator: "eq" | "neq" | "in" | "contains";
  value: Json;
}

export type RuleAction =
  | { type: "transition"; toStatusId: string }
  | { type: "assign"; assigneeId: string | null }
  | { type: "set_field"; field: "priority" | "storyPoints" | "dueDate"; value: Json }
  | { type: "add_label"; label: string }
  | { type: "comment"; text: string }
  | { type: "notify"; userId: string; title: string; body?: string }
  | { type: "add_to_sprint"; sprintId: string }
  | { type: "link_issue"; issueId: string };

function matchCondition(payload: Record<string, Json>, condition: RuleCondition): boolean {
  const actual: Json = payload[condition.field] ?? null;
  switch (condition.operator) {
    case "eq":
      return actual === condition.value;
    case "neq":
      return actual !== condition.value;
    case "in":
      return Array.isArray(condition.value) && condition.value.includes(actual);
    case "contains":
      return Array.isArray(actual) && actual.includes(condition.value);
    default:
      return false;
  }
}

export interface CreateAutomationRuleInput {
  organizationId: string;
  projectId: string;
  name: string;
  trigger: { type: RuleTriggerType };
  conditions?: RuleCondition[];
  actions: RuleAction[];
  dryRun?: boolean;
  createdBy: string;
}

export async function createAutomationRule(tx: Tx, input: CreateAutomationRuleInput) {
  const ruleId = id("rule");
  await tx.insert(schema.automationRule).values({
    id: ruleId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    name: input.name,
    trigger: input.trigger,
    conditions: (input.conditions ?? []) as unknown as Json,
    actions: input.actions as unknown as Json,
    dryRun: input.dryRun ?? false,
    createdBy: input.createdBy,
  });
  return { ruleId };
}

export async function listAutomationRules(tx: Tx, projectId: string) {
  return tx.select().from(schema.automationRule).where(eq(schema.automationRule.projectId, projectId)).orderBy(desc(schema.automationRule.createdAt));
}

export async function getAutomationRule(tx: Tx, ruleId: string) {
  const [row] = await tx.select().from(schema.automationRule).where(eq(schema.automationRule.id, ruleId));
  return row ?? null;
}

export async function setAutomationRuleEnabled(tx: Tx, ruleId: string, enabled: boolean) {
  await tx.update(schema.automationRule).set({ enabled, updatedAt: new Date() }).where(eq(schema.automationRule.id, ruleId));
}

export async function deleteAutomationRule(tx: Tx, ruleId: string) {
  await tx.delete(schema.automationRule).where(eq(schema.automationRule.id, ruleId));
}

export async function listAutomationRuns(tx: Tx, ruleId: string, limit = 50) {
  return tx.select().from(schema.automationRun).where(eq(schema.automationRun.ruleId, ruleId)).orderBy(desc(schema.automationRun.createdAt)).limit(limit);
}

/**
 * Claims up to `limit` pending rows across every workspace in one go —
 * apps/worker's system-wide scan, not one tenant's request, so `db` MUST
 * be the admin connection (see rls.sql). Mirrors email.ts's
 * claimPendingEmails exactly.
 */
export async function claimPendingAutomationEvents(db: AnyDb, limit = 10) {
  const claimed = await db.execute<{ id: string }>(
    sql`update automation_event set status = 'processing'
        where id in (
          select id from automation_event where status = 'pending' order by created_at limit ${limit} for update skip locked
        )
        returning id`,
  );
  const ids = claimed.map((r) => r.id);
  if (ids.length === 0) return [];
  return db.select().from(schema.automationEvent).where(inArray(schema.automationEvent.id, ids));
}

export async function markAutomationEventProcessed(db: AnyDb, eventId: string) {
  await db.update(schema.automationEvent).set({ status: "processed" }).where(eq(schema.automationEvent.id, eventId));
}

export async function markAutomationEventFailed(db: AnyDb, eventId: string) {
  await db.update(schema.automationEvent).set({ status: "failed" }).where(eq(schema.automationEvent.id, eventId));
}

type AutomationEventRow = typeof schema.automationEvent.$inferSelect;
type AutomationRuleRow = typeof schema.automationRule.$inferSelect;

async function executeActions(tx: Tx, rule: AutomationRuleRow, event: AutomationEventRow): Promise<Json> {
  const actions = (rule.actions as unknown as RuleAction[]) ?? [];
  const issueId = event.entityId;
  const actorId = rule.createdBy!;
  const origin = "automation" as const;
  const originClient = `automation:${rule.name}`;
  const automationContext: AutomationContext = { depth: event.depth + 1, ruleId: rule.id };
  const log: Json[] = [];

  for (const action of actions) {
    if (action.type === "transition") {
      await moveIssue(tx, { issueId, toStatusId: action.toStatusId, actorId, origin, originClient, automationContext });
    } else if (action.type === "assign") {
      await updateIssue(tx, issueId, { assigneeId: action.assigneeId, actorId, origin, originClient, automationContext });
    } else if (action.type === "set_field") {
      await updateIssue(tx, issueId, { [action.field]: action.value, actorId, origin, originClient, automationContext } as Parameters<typeof updateIssue>[2]);
    } else if (action.type === "add_label") {
      const [current] = await tx.select({ labels: schema.issue.labels }).from(schema.issue).where(eq(schema.issue.id, issueId));
      const labels = [...new Set([...(current?.labels ?? []), action.label])];
      await updateIssue(tx, issueId, { labels, actorId, origin, originClient, automationContext });
    } else if (action.type === "comment") {
      await addComment(tx, { issueId, authorId: actorId, bodyJson: { text: action.text }, origin, originClient });
    } else if (action.type === "notify") {
      await notify(tx, { organizationId: event.organizationId, userId: action.userId, eventType: "automation.rule", entityType: "issue", entityId: issueId, title: action.title, body: action.body });
    } else if (action.type === "add_to_sprint") {
      await addIssueToSprint(tx, action.sprintId, issueId);
    } else if (action.type === "link_issue") {
      await linkEntities(tx, { organizationId: event.organizationId, fromType: "issue", fromId: issueId, toType: "issue", toId: action.issueId, createdBy: actorId });
    }
    log.push(action as unknown as Json);
  }
  return log;
}

/**
 * The engine. Loads every enabled rule for the event's project, skips the
 * one rule (if any) whose own action caused this event, matches
 * trigger+conditions, and — unless over the per-rule rate limit or the
 * rule is in dry-run mode — executes its actions. Writes one
 * automation_run row per candidate rule regardless of outcome, so a rule
 * that never matches is just as visible as one that fires constantly.
 * An event at MAX_AUTOMATION_DEPTH or beyond is skipped entirely with no
 * per-rule runs (there's no meaningful "which rules would have matched"
 * to log once the chain is being cut off).
 */
export async function evaluateAutomationEvent(tx: Tx, event: AutomationEventRow): Promise<void> {
  if (event.depth >= MAX_AUTOMATION_DEPTH) return;

  const rules = await tx.select().from(schema.automationRule).where(and(eq(schema.automationRule.projectId, event.projectId), eq(schema.automationRule.enabled, true)));

  for (const rule of rules) {
    if (rule.id === event.causedByRuleId) continue;
    const trigger = rule.trigger as unknown as { type: RuleTriggerType };
    if (trigger.type !== event.eventType) continue;

    const conditions = (rule.conditions as unknown as RuleCondition[]) ?? [];
    const payload = event.payload as Record<string, Json>;
    const matched = conditions.every((c) => matchCondition(payload, c));

    if (!matched) {
      await tx.insert(schema.automationRun).values({ id: id("run"), organizationId: event.organizationId, ruleId: rule.id, eventId: event.id, status: "not_matched", input: event.payload });
      continue;
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentRuns = await tx
      .select({ id: schema.automationRun.id })
      .from(schema.automationRun)
      .where(and(eq(schema.automationRun.ruleId, rule.id), eq(schema.automationRun.status, "matched"), gte(schema.automationRun.createdAt, oneHourAgo)));
    if (recentRuns.length >= RATE_LIMIT_PER_RULE_PER_HOUR) {
      await tx.insert(schema.automationRun).values({ id: id("run"), organizationId: event.organizationId, ruleId: rule.id, eventId: event.id, status: "skipped_rate_limited", input: event.payload });
      continue;
    }

    if (rule.dryRun) {
      await tx.insert(schema.automationRun).values({ id: id("run"), organizationId: event.organizationId, ruleId: rule.id, eventId: event.id, status: "dry_run", input: event.payload, actionsRun: rule.actions });
      continue;
    }

    try {
      const actionsRun = await executeActions(tx, rule, event);
      await tx.insert(schema.automationRun).values({ id: id("run"), organizationId: event.organizationId, ruleId: rule.id, eventId: event.id, status: "matched", input: event.payload, actionsRun });
    } catch (err) {
      await tx.insert(schema.automationRun).values({
        id: id("run"),
        organizationId: event.organizationId,
        ruleId: rule.id,
        eventId: event.id,
        status: "failed",
        input: event.payload,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
