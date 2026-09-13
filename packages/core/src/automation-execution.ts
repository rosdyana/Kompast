import dns from "node:dns/promises";
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

/**
 * Core (non-custom) issue columns readable by condition_property/
 * action_set_property, keyed by the same property name the node config
 * uses, each paired with how to pull that value off a loaded issue row.
 * Single source of truth for AUTOMATION_READABLE_PROPERTY_KEYS below AND
 * readIssuePropertyValue's own dispatch, so the two can never drift apart —
 * a later frontend property-picker plan needs the same list.
 */
const CORE_READABLE_PROPERTY_ACCESSORS: Record<string, (issue: typeof schema.issue.$inferSelect) => unknown> = {
  assigneeId: (issue) => issue.assigneeId,
  reporterId: (issue) => issue.reporterId,
  priority: (issue) => issue.priority,
  startDate: (issue) => issue.startDate,
  dueDate: (issue) => issue.dueDate,
  epicId: (issue) => issue.epicId,
  sprint: (issue) => issue.sprintId,
  storyPoints: (issue) => issue.storyPoints,
};

/**
 * Core issue fields settable by action_set_property, OTHER than "status"/
 * "sprint" (dispatched to moveIssue/addIssueToSprint-removeIssueFromSprint
 * as special cases before this set is even checked — see
 * applySetProperty). Single source of truth for
 * AUTOMATION_SETTABLE_PROPERTY_KEYS below AND applySetProperty's own
 * dispatch.
 */
const CORE_SETTABLE_PROPERTY_KEYS = new Set(["title", "assigneeId", "priority", "storyPoints", "dueDate", "startDate", "epicId", "labels"]);

/**
 * Every property key the automation engine can READ off an issue — the
 * structural fields plus every core column above. Anything outside this
 * set is treated as a custom issue_property_definition key. Exported so a
 * later frontend property-picker plan has exactly one source of truth
 * instead of re-deriving its own copy that could silently drift from this
 * one.
 */
export const AUTOMATION_READABLE_PROPERTY_KEYS: readonly string[] = [...STRUCTURAL_PROPERTY_KEYS, ...Object.keys(CORE_READABLE_PROPERTY_ACCESSORS)];

/**
 * Every core property key action_set_property can WRITE — "status"/
 * "sprint" plus CORE_SETTABLE_PROPERTY_KEYS. Deliberately excludes "type"
 * and "reporterId" (applySetProperty fails loudly for either — see its own
 * comment) and every other structural/read-only field. Same
 * drift-prevention rationale as AUTOMATION_READABLE_PROPERTY_KEYS above.
 */
export const AUTOMATION_SETTABLE_PROPERTY_KEYS: readonly string[] = ["status", "sprint", ...CORE_SETTABLE_PROPERTY_KEYS];

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
  if (property in CORE_READABLE_PROPERTY_ACCESSORS) return CORE_READABLE_PROPERTY_ACCESSORS[property]!(issue);
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
  if (CORE_SETTABLE_PROPERTY_KEYS.has(property)) {
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
 * Best-effort SSRF guard for action_webhook's own address-family check:
 * true if `address` (already DNS-resolved, never the raw hostname — a
 * hostname can resolve to a private IP without looking like one) falls in
 * a loopback/link-local/private range. Deliberately not exhaustive — no
 * full IPv6 CIDR handling beyond the common ranges below, and this can't
 * defend against DNS rebinding between this check and the fetch call
 * itself. A reasonable best effort for the common ranges (including the
 * 169.254.169.254 cloud metadata endpoint), not a complete network
 * security boundary.
 */
function isDisallowedWebhookAddress(address: string, family: number): boolean {
  if (family === 4) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) return true; // malformed — fail closed
    const [a, b] = octets as [number, number, number, number];
    if (a === 127) return true; // loopback (127.0.0.0/8)
    if (a === 10) return true; // private (10.0.0.0/8)
    if (a === 172 && b >= 16 && b <= 31) return true; // private (172.16.0.0/12)
    if (a === 192 && b === 168) return true; // private (192.168.0.0/16)
    if (a === 169 && b === 254) return true; // link-local (169.254.0.0/16) — includes the cloud metadata endpoint
    if (a === 0) return true; // "this network" (0.0.0.0/8)
    return false;
  }
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized.startsWith("fe80:")) return true; // link-local (fe80::/10)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local (fc00::/7)
  if (normalized.startsWith("::ffff:")) return isDisallowedWebhookAddress(normalized.slice("::ffff:".length), 4); // IPv4-mapped IPv6
  return false;
}

/**
 * Resolves action_webhook's user-configured target URL and rejects it if
 * it points at a loopback/link-local/private address — this is the
 * engine's only outbound-fetch primitive, reachable by any user with
 * issues:write (not just an admin), and the request originates from
 * apps/worker's own network position. Throws (caught by executeNode's
 * existing catch, same as a real network error) rather than returning a
 * boolean, so callers can't forget to check it.
 */
async function assertWebhookUrlAllowed(rawUrl: string): Promise<void> {
  const hostname = new URL(rawUrl).hostname;
  const { address, family } = await dns.lookup(hostname);
  if (isDisallowedWebhookAddress(address, family)) throw new Error("Webhook target resolves to a disallowed address");
}

/**
 * Executes exactly one node's logic. Does not read or write the
 * automation_workflow_run_step row itself — the claim loop (Task 6/7)
 * owns that, so this function is trivially unit-testable node-by-node.
 *
 * `stepDepth` is the CURRENT step's own depth (passed in by
 * advanceWorkflowStep) — any automation_workflow_event this node's
 * mutation emits is stamped with this exact depth at the source, so a
 * downstream workflow chained off that event continues the SAME
 * chain-depth count instead of resetting to 0. This used to be hardcoded
 * to 0 and corrected after the fact via a compensating UPDATE in
 * automation-engine.ts, keyed on the run's own triggering issueId — which
 * silently missed any event tied to a DIFFERENT entity than that issue
 * (e.g. action_create_subtask's newly created subtask never got its
 * `issue.created` event's depth fixed up, letting a two-workflow mutual
 * subtask-creation loop bypass MAX_AUTOMATION_DEPTH entirely). Stamping
 * the right depth here, at the one place every node's mutation originates
 * from, can't miss a case like that.
 */
export async function executeNode(tx: Tx, node: AutomationNode, run: AutomationWorkflowRun, workflow: AutomationWorkflow, stepDepth: number): Promise<ExecuteStepResult> {
  const issueId = (run.context as { issueId: string }).issueId;
  const meta: ActionMeta = {
    actorId: workflow.createdBy!,
    origin: "automation",
    originClient: `automation-workflow:${workflow.name}`,
    automationContext: { depth: stepDepth, workflowId: workflow.id },
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
      await addComment(tx, { issueId, authorId: meta.actorId, bodyJson: [{ type: "paragraph", content: [{ type: "text", text: config.text, styles: {} }] }], origin: meta.origin, originClient: meta.originClient, automationContext: meta.automationContext });
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

    if (node.type === "action_webhook") {
      const config = node.config as { url: string; method: string; headers: Record<string, string>; bodyTemplate: Json };
      try {
        await assertWebhookUrlAllowed(config.url);
        const res = await fetch(config.url, {
          method: config.method,
          headers: { "Content-Type": "application/json", ...config.headers },
          body: JSON.stringify(config.bodyTemplate),
          // Bounded so a hung target can't hold this step's transaction
          // open indefinitely — advanceWorkflowStep recurses through an
          // entire run inside one open Postgres transaction, so a webhook
          // that never responds would otherwise block every other
          // tenant's workflow-step processing (the worker's step queue
          // has concurrency 1) and pin a Postgres connection. An abort
          // rejects with a DOMException named "AbortError", handled
          // generically by the catch below like any other network error.
          signal: AbortSignal.timeout(10_000),
          // Never auto-follow a redirect: assertWebhookUrlAllowed only
          // DNS-resolves and range-checks the INITIAL url — fetch's default
          // redirect: "follow" would transparently chase a Location header
          // straight past that guard (e.g. an attacker-controlled host
          // redirecting to http://169.254.169.254/... cloud metadata, or to
          // a loopback address), defeating the SSRF check entirely without
          // ever re-validating the redirect target. With "manual", Node's
          // native fetch (undici) does not follow the redirect itself —
          // empirically, in this repo's Node version, it returns the 3xx
          // response as-is (status/headers intact) rather than throwing or
          // returning an opaque-redirect response, hence the status-range
          // check below (with an `opaqueredirect` check kept alongside it
          // in case a future Node/undici version changes that).
          redirect: "manual",
        });
        if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
          return { status: "failed", error: "Webhook response was a redirect, which is not followed for security reasons" };
        }
        if (!res.ok) return { status: "failed", error: `Webhook returned ${res.status} ${res.statusText}` };
        return { status: "succeeded", output: { status: res.status } };
      } catch (err) {
        return { status: "failed", error: err instanceof Error ? err.message : String(err) };
      }
    }

    return { status: "failed", error: `Unhandled node type: ${node.type}` };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
