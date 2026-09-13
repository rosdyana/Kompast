import { and, eq, gte, inArray, sql, schema, type Json } from "@kompast/db";
import { CronExpressionParser } from "cron-parser";
import type { Tx, AnyDb } from "./types";
import { id } from "./ids";
import { executeNode, MAX_AUTOMATION_DEPTH, type ExecuteStepResult } from "./automation-execution";

const RATE_LIMIT_PER_WORKFLOW_PER_HOUR = 50;

/**
 * Triggers carry no logic of their own — executeNode has no branch for
 * either (Task 6 confirmed every executable node type is handled and these
 * two deliberately aren't: trigger_schedule is Task 8's own future
 * scope, trigger_event's only "logic" is having already matched in
 * matchAndStartRuns). advanceWorkflowStep routes around executeNode
 * entirely for these rather than passing it a node type it can't run.
 */
const TRIGGER_NODE_TYPES = new Set(["trigger_event", "trigger_schedule"]);

type AutomationWorkflowEventRow = typeof schema.automationWorkflowEvent.$inferSelect;
type AutomationWorkflowRunStepRow = typeof schema.automationWorkflowRunStep.$inferSelect;

/** System-wide scan across every workspace — admin connection only, same shape as claimPendingAutomationEvents. */
export async function claimPendingWorkflowEvents(db: AnyDb, limit = 10) {
  const claimed = await db.execute<{ id: string }>(
    sql`update automation_workflow_event set status = 'processing'
        where id in (
          select id from automation_workflow_event where status = 'pending' order by created_at limit ${limit} for update skip locked
        )
        returning id`,
  );
  const ids = claimed.map((r) => r.id);
  if (ids.length === 0) return [];
  return db.select().from(schema.automationWorkflowEvent).where(inArray(schema.automationWorkflowEvent.id, ids));
}

export async function markWorkflowEventProcessed(db: AnyDb, eventId: string) {
  await db.update(schema.automationWorkflowEvent).set({ status: "processed" }).where(eq(schema.automationWorkflowEvent.id, eventId));
}

/** Same shape, for automation_workflow_run_step: pending, or waiting past its resumeAt. */
export async function claimDueWorkflowSteps(db: AnyDb, limit = 10) {
  const claimed = await db.execute<{ id: string }>(
    sql`update automation_workflow_run_step set status = 'processing'
        where id in (
          select id from automation_workflow_run_step
          where status = 'pending' or (status = 'waiting' and resume_at <= now())
          order by created_at limit ${limit} for update skip locked
        )
        returning id`,
  );
  const ids = claimed.map((r) => r.id);
  if (ids.length === 0) return [];
  return db.select().from(schema.automationWorkflowRunStep).where(inArray(schema.automationWorkflowRunStep.id, ids));
}

/**
 * Trigger matching: for the event's project, every enabled workflow with a
 * matching trigger_event node — except the workflow that caused this exact
 * event — starts a new run, unless it's already over the hourly rate
 * limit. The first step is the trigger node itself (not its downstream
 * neighbor) so a fan-out trigger with multiple outgoing edges is walked
 * the same way any other node's fan-out is — see advanceWorkflowStep.
 * No "not_matched" audit row is written here (unlike the old engine) — a
 * workflow simply not having a matching trigger node isn't something
 * worth logging per-event; a run's own step trail is the audit record
 * once a run does start.
 */
export async function matchAndStartRuns(tx: Tx, event: AutomationWorkflowEventRow): Promise<void> {
  const workflows = await tx.select().from(schema.automationWorkflow).where(and(eq(schema.automationWorkflow.projectId, event.projectId), eq(schema.automationWorkflow.enabled, true)));

  for (const workflow of workflows) {
    if (workflow.id === event.causedByWorkflowId) continue;

    const triggerNodes = await tx
      .select()
      .from(schema.automationNode)
      .where(and(eq(schema.automationNode.workflowId, workflow.id), eq(schema.automationNode.type, "trigger_event")));
    const matchingTrigger = triggerNodes.find((n) => (n.config as { eventType: string }).eventType === event.eventType);
    if (!matchingTrigger) continue;

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentRuns = await tx
      .select({ id: schema.automationWorkflowRun.id })
      .from(schema.automationWorkflowRun)
      .where(and(eq(schema.automationWorkflowRun.workflowId, workflow.id), gte(schema.automationWorkflowRun.createdAt, oneHourAgo)));
    if (recentRuns.length >= RATE_LIMIT_PER_WORKFLOW_PER_HOUR) continue;

    const runId = id("wfrun");
    await tx.insert(schema.automationWorkflowRun).values({ id: runId, organizationId: event.organizationId, workflowId: workflow.id, context: { issueId: event.entityId, payload: event.payload } as Json });
    await tx.insert(schema.automationWorkflowRunStep).values({ id: id("wfstep"), runId, nodeId: matchingTrigger.id, depth: event.depth, status: "pending" });
  }
}

async function finalizeRunIfDone(tx: Tx, runId: string): Promise<void> {
  const activeSteps = await tx
    .select({ id: schema.automationWorkflowRunStep.id })
    .from(schema.automationWorkflowRunStep)
    .where(and(eq(schema.automationWorkflowRunStep.runId, runId), inArray(schema.automationWorkflowRunStep.status, ["pending", "processing", "waiting"])));
  if (activeSteps.length > 0) {
    // Belt-and-braces: explicitly keep the run "running" rather than just
    // returning. finalizeRunIfDone can be called before every sibling of a
    // fan-out has had its row inserted yet (advanceWorkflowStep inserts+
    // recurses into each edge in turn), so a run can, even correctly, be
    // seen as "no active steps YET" mid-fan-out — see advanceWorkflowStep's
    // two-pass insert-then-recurse split, which is the real fix for that.
    // Writing "running" here too means the run's status is always actively
    // kept in sync with the real step set on every call, rather than only
    // ever moving forward from its initial "running" default.
    await tx.update(schema.automationWorkflowRun).set({ status: "running" }).where(eq(schema.automationWorkflowRun.id, runId));
    return;
  }

  const allSteps = await tx.select({ status: schema.automationWorkflowRunStep.status }).from(schema.automationWorkflowRunStep).where(eq(schema.automationWorkflowRunStep.runId, runId));
  const finalStatus = allSteps.some((s) => s.status === "failed") ? "failed" : "completed";
  await tx.update(schema.automationWorkflowRun).set({ status: finalStatus }).where(eq(schema.automationWorkflowRun.id, runId));
}

/**
 * Claims-and-executes one step, then eagerly walks forward through any
 * outgoing edge(s) it unlocks (calling itself recursively for each newly
 * created next step) until every branch it touches naturally stops —
 * fails, waits on a delay, runs out of matching edges, or hits
 * MAX_AUTOMATION_DEPTH. A trigger node has no logic of its own, so it's
 * always one such pass-through: it "succeeds" immediately without ever
 * calling executeNode, then falls straight into the same edge-walking
 * below as any other node. A step already AT MAX_AUTOMATION_DEPTH is
 * marked skipped_max_depth without calling executeNode at all — only
 * THIS branch stops; sibling branches from an earlier fan-out (tracked as
 * their own independent step rows) are untouched. A step being handed back
 * in with `resumeAt` already set is a delay node's wait completing (see
 * claimDueWorkflowSteps) rather than a fresh visit — it's likewise treated
 * as an immediate pass-through instead of calling executeNode again, which
 * would otherwise just compute another fresh wait forever.
 */
export async function advanceWorkflowStep(tx: Tx, step: AutomationWorkflowRunStepRow): Promise<void> {
  if (step.depth >= MAX_AUTOMATION_DEPTH) {
    await tx.update(schema.automationWorkflowRunStep).set({ status: "skipped_max_depth" }).where(eq(schema.automationWorkflowRunStep.id, step.id));
    await finalizeRunIfDone(tx, step.runId);
    return;
  }

  const [node] = await tx.select().from(schema.automationNode).where(eq(schema.automationNode.id, step.nodeId));
  const [run] = await tx.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, step.runId));
  const [workflow] = await tx.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, run!.workflowId));

  const isTrigger = TRIGGER_NODE_TYPES.has(node!.type);
  // A non-null resumeAt means this exact step already went through executeNode
  // once before and came back "waiting" (a delay node) — claimDueWorkflowSteps
  // only re-claims such a row once resumeAt has passed, so being handed it
  // again means the wait is over, not that the wait should restart. executeNode
  // itself is stateless (a delay node always returns a FRESH "waiting" +
  // resumeAt computed from now()), so it can't tell "first visit" from
  // "resuming" on its own — that distinction is exactly this claim loop's job,
  // same as the trigger short-circuit above.
  const isResuming = step.resumeAt !== null;
  const result: ExecuteStepResult = isTrigger || isResuming ? { status: "succeeded" } : await executeNode(tx, node!, run!, workflow!);

  if (result.status === "waiting") {
    await tx.update(schema.automationWorkflowRunStep).set({ status: "waiting", resumeAt: result.resumeAt, output: result.output ?? null }).where(eq(schema.automationWorkflowRunStep.id, step.id));
    return; // a waiting step is still "active" — the run isn't finalized while it exists.
  }

  await tx
    .update(schema.automationWorkflowRunStep)
    .set({ status: result.status, output: result.output ?? null, error: result.error ?? null })
    .where(eq(schema.automationWorkflowRunStep.id, step.id));

  if (result.status === "succeeded") {
    if (!isTrigger && !isResuming) {
      // executeNode always hardcodes the AutomationContext it hands to
      // moveIssue/updateIssue/addComment/etc to `{ depth: 0, workflowId }`
      // (see automation-execution.ts's own comment on that literal — it
      // considers depth the claim loop's problem, not its own), so any
      // automation_workflow_event this action's mutation just caused is
      // sitting at depth 0 regardless of how deep this step actually is.
      // Fix it up to this step's own depth here so a downstream workflow
      // triggered off that event continues the SAME chain-depth count
      // (matchAndStartRuns seeds a new run's first step from event.depth)
      // instead of resetting it — that's what lets MAX_AUTOMATION_DEPTH
      // bound a long chain across several different workflows, not just
      // fan-out within one run. causedByWorkflowId is already correct
      // (set at the same callsite); only depth needs correcting.
      const issueId = (run!.context as { issueId: string }).issueId;
      await tx
        .update(schema.automationWorkflowEvent)
        .set({ depth: step.depth })
        .where(and(eq(schema.automationWorkflowEvent.causedByWorkflowId, workflow!.id), eq(schema.automationWorkflowEvent.entityId, issueId), eq(schema.automationWorkflowEvent.depth, 0)));
    }

    const outgoingEdges = await tx.select().from(schema.automationEdge).where(eq(schema.automationEdge.fromNodeId, node!.id));
    const matchingEdges = node!.type === "condition_property" ? outgoingEdges.filter((e) => e.fromHandle === result.branchTaken) : outgoingEdges;

    // Two passes, deliberately not merged: insert every sibling's row FIRST,
    // then recurse into each. If a single edge were inserted-and-recursed
    // before the next edge's row existed, that recursion's own
    // finalizeRunIfDone call would see an incomplete step set — e.g. one
    // sibling finishing instantly (no more edges) while its not-yet-created
    // sibling was actually going to end up "waiting" on a delay — and could
    // finalize the run as "completed" while a true sibling is still pending.
    // Inserting all rows up front makes every sibling visible to every
    // nested finalizeRunIfDone call from the very first one.
    const nextSteps = [];
    for (const edge of matchingEdges) {
      const [nextStep] = await tx
        .insert(schema.automationWorkflowRunStep)
        .values({ id: id("wfstep"), runId: step.runId, nodeId: edge.toNodeId, depth: step.depth + 1, status: "pending" })
        .returning();
      nextSteps.push(nextStep!);
    }
    for (const nextStep of nextSteps) {
      await advanceWorkflowStep(tx, nextStep);
    }
  }

  await finalizeRunIfDone(tx, step.runId);
}

function isScheduleDue(cron: string, lastFiredAt: Date | null): boolean {
  if (!lastFiredAt) return true; // never fired — due immediately
  const interval = CronExpressionParser.parse(cron, { currentDate: lastFiredAt });
  return interval.next().toDate().getTime() <= Date.now();
}

/**
 * Bypasses the event outbox entirely — a schedule tick isn't caused by an
 * issue mutation, so there's nothing for emitAutomationEvent to record.
 * Runs on its own ~60s poller (coarser than the 5s event/step pollers —
 * schedule granularity doesn't need second-level precision).
 */
export async function claimDueWorkflowSchedules(tx: Tx): Promise<void> {
  const scheduleNodes = await tx
    .select({ node: schema.automationNode, workflow: schema.automationWorkflow })
    .from(schema.automationNode)
    .innerJoin(schema.automationWorkflow, eq(schema.automationWorkflow.id, schema.automationNode.workflowId))
    .where(and(eq(schema.automationNode.type, "trigger_schedule"), eq(schema.automationWorkflow.enabled, true)));

  for (const { node, workflow } of scheduleNodes) {
    const config = node.config as { cron: string };
    if (!isScheduleDue(config.cron, node.lastFiredAt)) continue;

    const runId = id("wfrun");
    await tx.insert(schema.automationWorkflowRun).values({ id: runId, organizationId: workflow.organizationId, workflowId: workflow.id, context: {} as Json });
    await tx.insert(schema.automationWorkflowRunStep).values({ id: id("wfstep"), runId, nodeId: node.id, depth: 0, status: "pending" });
    await tx.update(schema.automationNode).set({ lastFiredAt: new Date() }).where(eq(schema.automationNode.id, node.id));
  }
}
