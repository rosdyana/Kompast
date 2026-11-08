import { loadEnv } from "@kompast/env";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { adminDb, schema, eq, withTenant } from "@kompast/db";
import {
  claimPendingEmails,
  markEmailSent,
  markEmailFailed,
  getMailCredentials,
  claimPendingReindexTasks,
  processReindexTask,
  markReindexTaskProcessed,
  markReindexTaskFailed,
  claimPendingWorkflowEvents,
  markWorkflowEventProcessed,
  markWorkflowEventFailed,
  matchAndStartRuns,
  claimDueWorkflowSteps,
  advanceWorkflowStep,
  markWorkflowStepFailed,
  claimDueWorkflowSchedules,
  claimJiraMigrations,
  withAuthorizedTenant,
} from "@kompast/core";
import { createMailer, NotificationEmail, SprintSummaryEmail } from "@kompast/mail";
import { runJiraMigrationTick, startDueJiraAutoSyncs } from "@kompast/import";

const env = loadEnv();
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const MAIL_QUEUE = "mail";
const REINDEX_QUEUE = "reindex";
const JIRA_MIGRATION_QUEUE = "jira-migration";

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
 * processReindexTask runs on the admin connection via withTenant — the same
 * shape the automation pollers below use — not withAuthorizedTenant as some
 * member. Reads are team-scoped by RLS (packages/db/rls.sql), so "any
 * member of the workspace" is no longer a neutral choice: whoever that
 * happened to be might not see the issue/comment being indexed, and the
 * task would fail or index nothing. Indexing has to see every entity to
 * keep the index complete; retrieval (askKompast, run as the asking user)
 * is where team scoping is enforced.
 */
async function processReindexBatch() {
  const claimed = await claimPendingReindexTasks(adminDb, 10);
  for (const task of claimed) {
    try {
      await withTenant(adminDb, { organizationId: task.organizationId, userId: "system" }, (tx) => processReindexTask(tx, task));
      await markReindexTaskProcessed(adminDb, task.id);
    } catch (err) {
      console.error(`[worker] reindex task ${task.id} failed:`, err);
      await markReindexTaskFailed(adminDb, task.id, err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * The workflow engine's event poller — claims pending automation_workflow_event
 * rows and matches them against enabled workflows' trigger_event nodes.
 * Runs inside a plain withTenant tx rather than withAuthorizedTenant —
 * there's no "acting user" concept here (a workflow run isn't attributed
 * to any one member), so this passes a synthetic "system" userId directly.
 */
async function processWorkflowEventBatch() {
  const events = await claimPendingWorkflowEvents(adminDb, 10);
  for (const event of events) {
    try {
      await withTenant(adminDb, { organizationId: event.organizationId, userId: "system" }, (tx) => matchAndStartRuns(tx, event));
      await markWorkflowEventProcessed(adminDb, event.id);
    } catch (err) {
      console.error(`Failed to process workflow event ${event.id}:`, err);
      await markWorkflowEventFailed(adminDb, event.id);
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
    let organizationId: string | undefined;
    try {
      const [run] = await adminDb.select({ organizationId: schema.automationWorkflowRun.organizationId }).from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, step.runId));
      organizationId = run!.organizationId;
      await withTenant(adminDb, { organizationId, userId: "system" }, (tx) => advanceWorkflowStep(tx, step));
    } catch (err) {
      console.error(`Failed to advance workflow step ${step.id}:`, err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Routes through the core function (not a bare adminDb.update) so the
      // step's RUN also gets finalized — leaving it stuck at "running"
      // forever was the bug this fix addresses. Falls back to the raw
      // update only if we couldn't even determine the run's organization
      // (so a tenant-scoped tx can't be opened), rather than losing the
      // failure entirely.
      if (organizationId) {
        await withTenant(adminDb, { organizationId, userId: "system" }, (tx) => markWorkflowStepFailed(tx, step, errorMessage));
      } else {
        await adminDb.update(schema.automationWorkflowRunStep).set({ status: "failed", error: errorMessage }).where(eq(schema.automationWorkflowRunStep.id, step.id));
      }
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
      await withTenant(adminDb, { organizationId, userId: "system" }, (tx) => claimDueWorkflowSchedules(tx, organizationId));
    } catch (err) {
      console.error(`Failed to process workflow schedules for org ${organizationId}:`, err);
    }
  }
}

/**
 * Leases up to two JIRA migrations that are discovering or running, and runs
 * one bounded tick for each (packages/import/src/jira/migration-runner.ts).
 * A tick saves its place in the migration's cursor, so an interrupted tick
 * (a restart, a JIRA rate limit) resumes at the last saved page. Each tick
 * has its own time budget, so the lease is renewed well before it lapses.
 * The claim runs on the admin connection (a system-wide scan), like the
 * other queue claims above. Each tick runs as the migration's creator.
 */
/** How often the auto-sync check runs. The job itself runs every few seconds; a due sync needs no finer a look. */
const JIRA_AUTO_SYNC_CHECK_MS = 60_000;
let lastJiraAutoSyncCheckAt = Number.NEGATIVE_INFINITY;

/**
 * Starts the syncs whose auto-sync interval has passed (startDueJiraAutoSyncs), at most once a minute. A migration
 * that can't be started is logged and left as it is: it's tried again on a later check.
 */
async function startJiraAutoSyncsIfDue() {
  if (Date.now() - lastJiraAutoSyncCheckAt < JIRA_AUTO_SYNC_CHECK_MS) return;
  lastJiraAutoSyncCheckAt = Date.now();
  const { started, failed } = await startDueJiraAutoSyncs({ adminDb, withTenantAs: withAuthorizedTenant });
  for (const id of started) console.log(`[worker] jira migration ${id}: auto-sync started`);
  for (const f of failed) console.error(`[worker] jira migration ${f.migrationId}: auto-sync could not start: ${f.error}`);
}

async function processJiraMigrationBatch() {
  try {
    await startJiraAutoSyncsIfDue();
  } catch (err) {
    console.error("[worker] jira auto-sync check failed:", err);
  }
  const migrations = await claimJiraMigrations(adminDb);
  for (const migration of migrations) {
    try {
      await runJiraMigrationTick({ adminDb, withTenantAs: withAuthorizedTenant }, migration);
    } catch (err) {
      console.error(`[worker] jira migration ${migration.id} tick failed:`, err);
    }
  }
}

const mailQueue = new Queue(MAIL_QUEUE, { connection });
const reindexQueue = new Queue(REINDEX_QUEUE, { connection });
const workflowEventQueue = new Queue("automation-workflow-events", { connection });
const workflowStepQueue = new Queue("automation-workflow-steps", { connection });
// Assumes a single worker replica: unlike the event/step queues,
// claimDueWorkflowSchedules has no FOR UPDATE SKIP LOCKED atomic claim, so
// two concurrent replicas could both see the same due schedule and
// double-fire it. Not reachable at the current single-worker deployment
// shape — revisit if that ever changes.
const workflowScheduleQueue = new Queue("automation-workflow-schedules", { connection });
const jiraMigrationQueue = new Queue(JIRA_MIGRATION_QUEUE, { connection });
const mailWorker = new Worker(MAIL_QUEUE, () => processOutboxBatch(), { connection });
const reindexWorker = new Worker(REINDEX_QUEUE, () => processReindexBatch(), { connection });
const workflowEventWorker = new Worker("automation-workflow-events", () => processWorkflowEventBatch(), { connection });
const workflowStepWorker = new Worker("automation-workflow-steps", () => processWorkflowStepBatch(), { connection });
const workflowScheduleWorker = new Worker("automation-workflow-schedules", () => processWorkflowSchedules(), { connection });
// lockDuration: BullMQ renews a job's lock from a timer, so an event-loop stall longer than the lock (BullMQ's
// default is 30 s) loses it. That is what logged "could not renew lock" and "Missing lock ... moveToFinished" for
// this job. One job runs up to two JIRA ticks back to back, and each tick stops starting pages after its 4-minute
// budget and finishes the page in hand, so a job can run past 8 minutes. 10 minutes keeps the lock alive through a
// whole job and through any stall short of that. A worker that dies is retried after this window instead of at
// 30 s. The DB lease (JIRA_MIGRATION_LEASE_MS, 5 minutes) is what stops two workers processing one migration.
const JIRA_MIGRATION_LOCK_MS = 10 * 60_000;
const jiraMigrationWorker = new Worker(JIRA_MIGRATION_QUEUE, () => processJiraMigrationBatch(), { connection, lockDuration: JIRA_MIGRATION_LOCK_MS });
mailWorker.on("failed", (job, err) => console.error(`[worker] mail job ${job?.id} failed:`, err));
reindexWorker.on("failed", (job, err) => console.error(`[worker] reindex job ${job?.id} failed:`, err));
workflowEventWorker.on("failed", (job, err) => console.error(`[worker] workflow event job ${job?.id} failed:`, err));
workflowStepWorker.on("failed", (job, err) => console.error(`[worker] workflow step job ${job?.id} failed:`, err));
workflowScheduleWorker.on("failed", (job, err) => console.error(`[worker] workflow schedule job ${job?.id} failed:`, err));
jiraMigrationWorker.on("failed", (job, err) => console.error(`[worker] jira migration job ${job?.id} failed:`, err));

process.on("SIGTERM", async () => {
  await mailWorker.close();
  await reindexWorker.close();
  await workflowEventWorker.close();
  await workflowStepWorker.close();
  await workflowScheduleWorker.close();
  await jiraMigrationWorker.close();
  await mailQueue.close();
  await reindexQueue.close();
  await workflowEventQueue.close();
  await workflowStepQueue.close();
  await workflowScheduleQueue.close();
  await jiraMigrationQueue.close();
  process.exit(0);
});

async function main() {
  // Re-adding a repeatable job with the same name + repeat options on
  // every boot is idempotent — BullMQ keys a repeatable job by those, not
  // by a fresh id each time — so this is safe to run on every worker
  // restart.
  await mailQueue.add("process-outbox", {}, { repeat: { every: 15_000 } });
  await reindexQueue.add("process-reindex", {}, { repeat: { every: 10_000 } });
  await workflowEventQueue.add("process-workflow-events", {}, { repeat: { every: 5_000 } });
  await workflowStepQueue.add("process-workflow-steps", {}, { repeat: { every: 5_000 } });
  await workflowScheduleQueue.add("process-workflow-schedules", {}, { repeat: { every: 60_000 } });
  await jiraMigrationQueue.add("process-jira-migrations", {}, { repeat: { every: 5_000 } });
  // Log the host only: REDIS_URL can carry a password.
  const redisHost = new URL(env.REDIS_URL);
  console.log(`[worker] started, connected to redis at ${redisHost.protocol}//${redisHost.host}`);
}

main();
