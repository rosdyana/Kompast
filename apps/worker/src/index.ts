import { loadEnv } from "@kompast/env";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { adminDb, schema, eq, withTenant } from "@kompast/db";
import {
  claimPendingEmails,
  markEmailSent,
  markEmailFailed,
  getMailCredentials,
  claimPendingAutomationEvents,
  evaluateAutomationEvent,
  markAutomationEventProcessed,
  markAutomationEventFailed,
  claimPendingReindexTasks,
  processReindexTask,
  markReindexTaskProcessed,
  markReindexTaskFailed,
  withAuthorizedTenant,
  claimPendingWorkflowEvents,
  markWorkflowEventProcessed,
  matchAndStartRuns,
  claimDueWorkflowSteps,
  advanceWorkflowStep,
  claimDueWorkflowSchedules,
} from "@kompast/core";
import { createMailer, NotificationEmail, SprintSummaryEmail } from "@kompast/mail";

const env = loadEnv();
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const MAIL_QUEUE = "mail";
const AUTOMATION_QUEUE = "automation";
const REINDEX_QUEUE = "reindex";

interface NotificationTemplateProps {
  title: string;
  body: string | null;
  actionUrl: string;
  actionLabel: string;
}

interface SprintSummaryTemplateProps {
  subject: string;
  body: string;
}

function buildTemplate(templateKey: string, props: unknown) {
  if (templateKey === "notification") {
    const p = props as NotificationTemplateProps;
    return NotificationEmail({ title: p.title, body: p.body ?? undefined, actionUrl: p.actionUrl, actionLabel: p.actionLabel });
  }
  if (templateKey === "sprint-summary") {
    const p = props as SprintSummaryTemplateProps;
    return SprintSummaryEmail({ subject: p.subject, body: p.body });
  }
  throw new Error(`Unknown email template: ${templateKey}`);
}

/**
 * Claims and sends one batch of pending email_outbox rows. There is no
 * explicit "wake up now" signal from apps/web yet (it only writes the
 * outbox row inside the same transaction as whatever triggered it — see
 * packages/db/src/schema/notification.ts) — this function is driven purely
 * by the repeatable "process-outbox" job below, so worst-case delivery
 * latency is that job's interval. Fine for notification email; would need
 * revisiting for something latency-sensitive.
 */
async function processOutboxBatch() {
  const claimed = await claimPendingEmails(adminDb, 10);
  if (claimed.length === 0) return;

  const creds = await getMailCredentials(adminDb);
  if (!creds) {
    for (const row of claimed) await markEmailFailed(adminDb, row.id, "Mail is not configured — see /settings");
    return;
  }

  const mailer = createMailer(creds);
  for (const row of claimed) {
    try {
      const react = buildTemplate(row.templateKey, row.templateProps);
      const result = await mailer.send({ to: row.toEmail, subject: row.subject, react });
      await markEmailSent(adminDb, row.id, result.providerMessageId);
    } catch (err) {
      await markEmailFailed(adminDb, row.id, err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * evaluateAutomationEvent runs entirely inside packages/core's normal
 * withAuthorizedTenant (RLS-scoped tx), same as every other mutation —
 * the worker deliberately doesn't get a special admin-tenant bypass for
 * running rule actions. withAuthorizedTenant needs *some* real member of
 * the event's organization to satisfy requireMembership; which member
 * doesn't matter for correctness (RLS itself only checks
 * organization_id, and each action's actual attribution inside
 * automation.ts's executeActions always uses the matching rule's own
 * createdBy, not this one) — it's just the account requireMembership
 * checks against, so any member of that workspace works.
 */
async function findAnyMember(organizationId: string): Promise<string | null> {
  const [row] = await adminDb.select({ userId: schema.member.userId }).from(schema.member).where(eq(schema.member.organizationId, organizationId)).limit(1);
  return row?.userId ?? null;
}

async function processAutomationBatch() {
  const claimed = await claimPendingAutomationEvents(adminDb, 10);
  for (const event of claimed) {
    try {
      const memberUserId = await findAnyMember(event.organizationId);
      if (!memberUserId) {
        await markAutomationEventFailed(adminDb, event.id);
        continue;
      }
      await withAuthorizedTenant({ userId: memberUserId, organizationId: event.organizationId }, (tx) => evaluateAutomationEvent(tx, event));
      await markAutomationEventProcessed(adminDb, event.id);
    } catch (err) {
      console.error(`[worker] automation event ${event.id} failed:`, err);
      await markAutomationEventFailed(adminDb, event.id);
    }
  }
}

/**
 * Same withAuthorizedTenant + findAnyMember shape as processAutomationBatch
 * above — processReindexTask writes into the (RLS-protected) embedding
 * table, so it needs a real tenant-scoped tx, not the bare admin
 * connection claimPendingReindexTasks itself uses.
 */
async function processReindexBatch() {
  const claimed = await claimPendingReindexTasks(adminDb, 10);
  for (const task of claimed) {
    try {
      const memberUserId = await findAnyMember(task.organizationId);
      if (!memberUserId) {
        await markReindexTaskFailed(adminDb, task.id, "No member found for organization");
        continue;
      }
      await withAuthorizedTenant({ userId: memberUserId, organizationId: task.organizationId }, (tx) => processReindexTask(tx, task));
      await markReindexTaskProcessed(adminDb, task.id);
    } catch (err) {
      console.error(`[worker] reindex task ${task.id} failed:`, err);
      await markReindexTaskFailed(adminDb, task.id, err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * New node-graph engine's event poller — separate queue/table from
 * processAutomationBatch's above (see automation-workflow-events schema
 * comment): claimPendingWorkflowEvents claims from automation_workflow_event,
 * not automation_event, so this can never race the old engine's own claim.
 * Unlike processAutomationBatch, matchAndStartRuns runs inside a plain
 * withTenant tx rather than withAuthorizedTenant — there's no "acting user"
 * concept here (a workflow run isn't attributed to any one member), so
 * this passes a synthetic "system" userId directly rather than looking up
 * a real member via findAnyMember.
 */
async function processWorkflowEventBatch() {
  const events = await claimPendingWorkflowEvents(adminDb, 10);
  for (const event of events) {
    try {
      await withTenant(adminDb, { organizationId: event.organizationId, userId: "system" }, (tx) => matchAndStartRuns(tx, event));
      await markWorkflowEventProcessed(adminDb, event.id);
    } catch (err) {
      console.error(`Failed to process workflow event ${event.id}:`, err);
      await adminDb.update(schema.automationWorkflowEvent).set({ status: "failed" }).where(eq(schema.automationWorkflowEvent.id, event.id));
    }
  }
}

/**
 * Same shape as processWorkflowEventBatch above. claimDueWorkflowSteps
 * claims across every workspace at once (admin connection), so the run's
 * organizationId has to be looked up per-step before a tenant-scoped tx
 * can be opened for advanceWorkflowStep itself.
 */
async function processWorkflowStepBatch() {
  const steps = await claimDueWorkflowSteps(adminDb, 10);
  for (const step of steps) {
    try {
      const [run] = await adminDb.select({ organizationId: schema.automationWorkflowRun.organizationId }).from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, step.runId));
      await withTenant(adminDb, { organizationId: run!.organizationId, userId: "system" }, (tx) => advanceWorkflowStep(tx, step));
    } catch (err) {
      console.error(`Failed to advance workflow step ${step.id}:`, err);
      await adminDb.update(schema.automationWorkflowRunStep).set({ status: "failed", error: err instanceof Error ? err.message : String(err) }).where(eq(schema.automationWorkflowRunStep.id, step.id));
    }
  }
}

/**
 * Coarser ~60s poller (see claimDueWorkflowSchedules's own comment) — no
 * event outbox involved, so this walks every enabled workflow's
 * organization directly rather than claiming rows. One organization's
 * failure (e.g. a malformed cron string on one of its trigger_schedule
 * nodes) is caught here so it can't stop other organizations from being
 * checked in the same poll cycle.
 */
async function processWorkflowSchedules() {
  const workflows = await adminDb.select({ organizationId: schema.automationWorkflow.organizationId }).from(schema.automationWorkflow).where(eq(schema.automationWorkflow.enabled, true));
  const organizationIds = [...new Set(workflows.map((w) => w.organizationId))];
  for (const organizationId of organizationIds) {
    try {
      await withTenant(adminDb, { organizationId, userId: "system" }, (tx) => claimDueWorkflowSchedules(tx));
    } catch (err) {
      console.error(`Failed to process workflow schedules for org ${organizationId}:`, err);
    }
  }
}

const mailQueue = new Queue(MAIL_QUEUE, { connection });
const automationQueue = new Queue(AUTOMATION_QUEUE, { connection });
const reindexQueue = new Queue(REINDEX_QUEUE, { connection });
const workflowEventQueue = new Queue("automation-workflow-events", { connection });
const workflowStepQueue = new Queue("automation-workflow-steps", { connection });
const workflowScheduleQueue = new Queue("automation-workflow-schedules", { connection });
const mailWorker = new Worker(MAIL_QUEUE, () => processOutboxBatch(), { connection });
const automationWorker = new Worker(AUTOMATION_QUEUE, () => processAutomationBatch(), { connection });
const reindexWorker = new Worker(REINDEX_QUEUE, () => processReindexBatch(), { connection });
const workflowEventWorker = new Worker("automation-workflow-events", () => processWorkflowEventBatch(), { connection });
const workflowStepWorker = new Worker("automation-workflow-steps", () => processWorkflowStepBatch(), { connection });
const workflowScheduleWorker = new Worker("automation-workflow-schedules", () => processWorkflowSchedules(), { connection });
mailWorker.on("failed", (job, err) => console.error(`[worker] mail job ${job?.id} failed:`, err));
automationWorker.on("failed", (job, err) => console.error(`[worker] automation job ${job?.id} failed:`, err));
reindexWorker.on("failed", (job, err) => console.error(`[worker] reindex job ${job?.id} failed:`, err));
workflowEventWorker.on("failed", (job, err) => console.error(`[worker] workflow event job ${job?.id} failed:`, err));
workflowStepWorker.on("failed", (job, err) => console.error(`[worker] workflow step job ${job?.id} failed:`, err));
workflowScheduleWorker.on("failed", (job, err) => console.error(`[worker] workflow schedule job ${job?.id} failed:`, err));

process.on("SIGTERM", async () => {
  await mailWorker.close();
  await automationWorker.close();
  await reindexWorker.close();
  await workflowEventWorker.close();
  await workflowStepWorker.close();
  await workflowScheduleWorker.close();
  await mailQueue.close();
  await automationQueue.close();
  await reindexQueue.close();
  await workflowEventQueue.close();
  await workflowStepQueue.close();
  await workflowScheduleQueue.close();
  process.exit(0);
});

async function main() {
  // Re-adding a repeatable job with the same name + repeat options on
  // every boot is idempotent — BullMQ keys a repeatable job by those, not
  // by a fresh id each time — so this is safe to run on every worker
  // restart.
  await mailQueue.add("process-outbox", {}, { repeat: { every: 15_000 } });
  await automationQueue.add("process-events", {}, { repeat: { every: 5_000 } });
  await reindexQueue.add("process-reindex", {}, { repeat: { every: 10_000 } });
  await workflowEventQueue.add("process-workflow-events", {}, { repeat: { every: 5_000 } });
  await workflowStepQueue.add("process-workflow-steps", {}, { repeat: { every: 5_000 } });
  await workflowScheduleQueue.add("process-workflow-schedules", {}, { repeat: { every: 60_000 } });
  console.log(`[worker] started, connected to redis at ${env.REDIS_URL}`);
}

main();
