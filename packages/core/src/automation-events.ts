import { schema, type Json } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

/**
 * Split out from the workflow engine specifically to avoid a circular
 * import: issue.ts/comment.ts need to call emitAutomationEvent (to record
 * that a mutation happened), while automation-execution.ts's node
 * executor needs to call updateIssue/moveIssue/addComment (to run a
 * matched workflow's actions). Neither of those two facts needs to know
 * about the other's file, so this tiny module — no dependency on
 * issue.ts/comment.ts/etc — is what both sides import from instead of
 * each other.
 */

export interface AutomationContext {
  depth: number;
  workflowId?: string;
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
 * transactional-outbox row (`automation_workflow_event`) in the SAME
 * transaction as the mutation that caused it (same reasoning as
 * email_outbox). Called unconditionally regardless of origin — an
 * automation-caused write DOES emit its own event, so one workflow's
 * action can legitimately trigger a different workflow (bounded by
 * MAX_AUTOMATION_DEPTH in automation-execution.ts). The loop-prevention
 * guardrail lives in matchAndStartRuns, not here: this function's only
 * job is "record that something happened."
 */
export async function emitAutomationEvent(tx: Tx, input: EmitAutomationEventInput) {
  const depth = input.automationContext?.depth ?? 0;
  await tx.insert(schema.automationWorkflowEvent).values({
    id: id("wfevent"),
    organizationId: input.organizationId,
    projectId: input.projectId,
    eventType: input.eventType,
    entityType: "issue",
    entityId: input.entityId,
    payload: input.payload,
    depth,
    causedByWorkflowId: input.automationContext?.workflowId ?? null,
  });
}
