import { eq, schema, type Json } from "@kompast/db";
import type { Tx } from "./types";
import { createIssue, moveIssue, updateIssue, updateIssueCustomField } from "./issue";
import { addComment } from "./comment";
import { notify } from "./notification";
import { addIssueToSprint, removeIssueFromSprint } from "./sprint";
import { linkEntities } from "./link";
import type { AutomationContext } from "./automation-events";

export const MAX_AUTOMATION_DEPTH = 5;

type AutomationNode = typeof schema.automationNode.$inferSelect;
type AutomationWorkflowRun = typeof schema.automationWorkflowRun.$inferSelect;
type AutomationWorkflow = typeof schema.automationWorkflow.$inferSelect;

export interface ExecuteStepResult {
  status: "succeeded" | "failed" | "waiting";
  output?: Json;
  error?: string;
  /** Only set for condition_property. */
  branchTaken?: "true" | "false";
  /** Only set when status = "waiting". */
  resumeAt?: Date;
}

/**
 * Structural fields every issue has that aren't issue_property_definition
 * rows — union'd with the real property list to build the condition/
 * action node's full property picker. See the spec's "Node types" section.
 */
const STRUCTURAL_PROPERTY_KEYS = new Set(["status", "type", "labels", "title"]);

function matchCondition(actual: unknown, operator: string, expected: Json): boolean {
  switch (operator) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual as Json);
    case "contains":
      return Array.isArray(actual) && actual.includes(expected);
    default:
      return false;
  }
}

/** Reads whichever field the condition/action targets, whether it's a real column, a core issue_property_definition key, or a custom field. */
async function readIssuePropertyValue(tx: Tx, issueId: string, property: string): Promise<unknown> {
  const [issue] = await tx.select().from(schema.issue).where(eq(schema.issue.id, issueId));
  if (!issue) throw new Error(`Issue ${issueId} not found`);
  if (STRUCTURAL_PROPERTY_KEYS.has(property)) {
    if (property === "status") return issue.statusId;
    if (property === "type") return issue.typeId;
    if (property === "labels") return issue.labels;
    if (property === "title") return issue.title;
  }
  const coreColumnMap: Record<string, unknown> = {
    assigneeId: issue.assigneeId,
    reporterId: issue.reporterId,
    priority: issue.priority,
    startDate: issue.startDate,
    dueDate: issue.dueDate,
    epicId: issue.epicId,
    sprint: issue.sprintId,
    storyPoints: issue.storyPoints,
  };
  if (property in coreColumnMap) return coreColumnMap[property];
  return (issue.customFields as Record<string, unknown> | null)?.[property] ?? null;
}

interface ActionMeta {
  actorId: string;
  origin: "automation";
  originClient: string;
  automationContext: AutomationContext;
}

/** action_set_property's property -> core-mutation dispatch table. Mirrors the issue-detail page's coreFieldRenderers dispatch-by-key pattern, for writes instead of rendering. */
async function applySetProperty(tx: Tx, issueId: string, property: string, value: Json, meta: ActionMeta): Promise<void> {
  if (property === "status") {
    await moveIssue(tx, { issueId, toStatusId: value as string, actorId: meta.actorId, origin: meta.origin, originClient: meta.originClient, automationContext: meta.automationContext });
    return;
  }
  if (property === "sprint") {
    if (value) await addIssueToSprint(tx, value as string, issueId, { actorId: meta.actorId, origin: meta.origin, originClient: meta.originClient });
    else await removeIssueFromSprint(tx, issueId, { actorId: meta.actorId, origin: meta.origin, originClient: meta.originClient });
    return;
  }
  const coreUpdateFields = new Set(["title", "assigneeId", "priority", "storyPoints", "dueDate", "startDate", "epicId", "labels"]);
  if (coreUpdateFields.has(property)) {
    await updateIssue(tx, issueId, { [property]: value, actorId: meta.actorId, origin: meta.origin, originClient: meta.originClient, automationContext: meta.automationContext } as Parameters<typeof updateIssue>[2]);
    return;
  }
  // "type" and "reporterId" have no corresponding core mutation — updateIssue
  // has no reporterId field at all (reporter is fixed at issue creation) and
  // no issue-type-change support either. Falling through to
  // updateIssueCustomField for either would silently merge a bogus
  // type/reporterId key into the jsonb customFields blob while leaving the
  // real column untouched — fail loudly instead.
  if (property === "type" || property === "reporterId") {
    throw new Error(`Property "${property}" cannot be set by an automation action`);
  }
  // Anything else is a custom issue_property_definition key.
  await updateIssueCustomField(tx, issueId, property, value, { actorId: meta.actorId, origin: meta.origin, originClient: meta.originClient, automationContext: meta.automationContext });
}

function delayResumeAt(config: { amount: number; unit: "minutes" | "hours" | "days" }): Date {
  const msPerUnit = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
  return new Date(Date.now() + config.amount * msPerUnit[config.unit]);
}

/**
 * Executes exactly one node's logic. Does not read or write the
 * automation_workflow_run_step row itself — the claim loop (Task 6/7)
 * owns that, so this function is trivially unit-testable node-by-node.
 */
export async function executeNode(tx: Tx, node: AutomationNode, run: AutomationWorkflowRun, workflow: AutomationWorkflow): Promise<ExecuteStepResult> {
  const issueId = (run.context as { issueId: string }).issueId;
  const meta: ActionMeta = {
    actorId: workflow.createdBy!,
    origin: "automation",
    originClient: `automation-workflow:${workflow.name}`,
    automationContext: { depth: 0, workflowId: workflow.id }, // depth is set by the claim loop when it computes the NEXT step's depth; not needed by executeNode itself.
  };

  try {
    if (node.type === "condition_property") {
      const config = node.config as { property: string; operator: string; value: Json };
      const actual = await readIssuePropertyValue(tx, issueId, config.property);
      const matched = matchCondition(actual, config.operator, config.value);
      return { status: "succeeded", branchTaken: matched ? "true" : "false", output: { actual: actual as Json, matched } };
    }

    if (node.type === "delay") {
      const config = node.config as { amount: number; unit: "minutes" | "hours" | "days" };
      return { status: "waiting", resumeAt: delayResumeAt(config) };
    }

    if (workflow.dryRun) {
      // Compute-but-don't-apply: log the intended action without calling any mutation.
      return { status: "succeeded", output: { dryRun: true, node: node.type, config: node.config } };
    }

    if (node.type === "action_set_property") {
      const config = node.config as { property: string; value: Json };
      await applySetProperty(tx, issueId, config.property, config.value, meta);
      return { status: "succeeded", output: { property: config.property, value: config.value } };
    }
    if (node.type === "action_add_label") {
      const config = node.config as { label: string };
      const [current] = await tx.select({ labels: schema.issue.labels }).from(schema.issue).where(eq(schema.issue.id, issueId));
      const labels = [...new Set([...(current?.labels ?? []), config.label])];
      await updateIssue(tx, issueId, { labels, actorId: meta.actorId, origin: meta.origin, originClient: meta.originClient, automationContext: meta.automationContext });
      return { status: "succeeded" };
    }
    if (node.type === "action_comment") {
      const config = node.config as { text: string };
      await addComment(tx, { issueId, authorId: meta.actorId, bodyJson: [{ type: "paragraph", content: [{ type: "text", text: config.text, styles: {} }] }], origin: meta.origin, originClient: meta.originClient });
      return { status: "succeeded" };
    }
    if (node.type === "action_notify") {
      const config = node.config as { userId: string; title: string; body?: string };
      const [issue] = await tx.select({ organizationId: schema.issue.organizationId }).from(schema.issue).where(eq(schema.issue.id, issueId));
      await notify(tx, { organizationId: issue!.organizationId, userId: config.userId, eventType: "automation.rule", entityType: "issue", entityId: issueId, title: config.title, body: config.body });
      return { status: "succeeded" };
    }
    if (node.type === "action_link_issue") {
      const config = node.config as { issueId: string };
      const [issue] = await tx.select({ organizationId: schema.issue.organizationId }).from(schema.issue).where(eq(schema.issue.id, issueId));
      await linkEntities(tx, { organizationId: issue!.organizationId, fromType: "issue", fromId: issueId, toType: "issue", toId: config.issueId, createdBy: meta.actorId });
      return { status: "succeeded" };
    }
    if (node.type === "action_create_subtask") {
      const config = node.config as { typeId: string; title: string };
      const [issue] = await tx.select().from(schema.issue).where(eq(schema.issue.id, issueId));
      const statuses = await tx.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, issue!.projectId));
      const statusId = (statuses.find((s) => s.category === "todo") ?? statuses[0])!.id;
      await createIssue(tx, {
        organizationId: issue!.organizationId,
        projectId: issue!.projectId,
        typeId: config.typeId,
        statusId,
        title: config.title,
        reporterId: meta.actorId,
        parentId: issueId,
        origin: meta.origin,
        originClient: meta.originClient,
        automationContext: meta.automationContext,
      });
      return { status: "succeeded" };
    }

    return { status: "failed", error: `Unhandled node type: ${node.type}` };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
