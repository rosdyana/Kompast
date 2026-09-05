import { schema, type Json } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

/**
 * Split out from automation.ts specifically to avoid a circular import:
 * issue.ts/comment.ts need to call emitAutomationEvent (to record that a
 * mutation happened), while automation.ts's engine needs to call
 * updateIssue/moveIssue/addComment (to execute a matched rule's actions).
 * Neither of those two facts needs to know about the other's file, so
 * this tiny module — no dependency on issue.ts/comment.ts/etc — is what
 * both sides import from instead of each other.
 */

/** Threaded through a mutation call so its own emitAutomationEvent call knows this write came from a rule's action — see automation.ts's evaluateAutomationEvent loop-guards. */
export interface AutomationContext {
  depth: number;
  ruleId: string;
}

export type RuleTriggerType = "issue.created" | "issue.updated" | "issue.transitioned" | "issue.assigned" | "issue.commented";

export interface EmitAutomationEventInput {
  organizationId: string;
  projectId: string;
  eventType: RuleTriggerType;
  entityId: string;
  payload: Json;
  automationContext?: AutomationContext;
}

/**
 * The single choke point for "a domain event happened" — writes a
 * transactional-outbox row in the SAME transaction as the mutation that
 * caused it (same reasoning as email_outbox). Called unconditionally
 * regardless of origin — an automation-caused write DOES emit its own
 * event, so one rule's action can legitimately trigger a different rule
 * (bounded by MAX_AUTOMATION_DEPTH in automation.ts). The two loop-
 * prevention guardrails live in evaluateAutomationEvent, not here: this
 * function's only job is "record that something happened."
 */
export async function emitAutomationEvent(tx: Tx, input: EmitAutomationEventInput) {
  await tx.insert(schema.automationEvent).values({
    id: id("aevent"),
    organizationId: input.organizationId,
    projectId: input.projectId,
    eventType: input.eventType,
    entityType: "issue",
    entityId: input.entityId,
    payload: input.payload,
    depth: input.automationContext?.depth ?? 0,
    causedByRuleId: input.automationContext?.ruleId ?? null,
  });
}
