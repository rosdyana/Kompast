import { loadEnv } from "@kompast/env";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { adminDb, schema, eq } from "@kompast/db";
import {
  claimPendingEmails,
  markEmailSent,
  markEmailFailed,
  getMailCredentials,
  claimPendingAutomationEvents,
  evaluateAutomationEvent,
  markAutomationEventProcessed,
  markAutomationEventFailed,
  withAuthorizedTenant,
} from "@kompast/core";
import { createMailer, NotificationEmail } from "@kompast/mail";

const env = loadEnv();
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const MAIL_QUEUE = "mail";
const AUTOMATION_QUEUE = "automation";

interface NotificationTemplateProps {
  title: string;
  body: string | null;
  actionUrl: string;
  actionLabel: string;
}

function buildTemplate(templateKey: string, props: unknown) {
  if (templateKey === "notification") {
    const p = props as NotificationTemplateProps;
    return NotificationEmail({ title: p.title, body: p.body ?? undefined, actionUrl: p.actionUrl, actionLabel: p.actionLabel });
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

const mailQueue = new Queue(MAIL_QUEUE, { connection });
const automationQueue = new Queue(AUTOMATION_QUEUE, { connection });
const mailWorker = new Worker(MAIL_QUEUE, () => processOutboxBatch(), { connection });
const automationWorker = new Worker(AUTOMATION_QUEUE, () => processAutomationBatch(), { connection });
mailWorker.on("failed", (job, err) => console.error(`[worker] mail job ${job?.id} failed:`, err));
automationWorker.on("failed", (job, err) => console.error(`[worker] automation job ${job?.id} failed:`, err));

process.on("SIGTERM", async () => {
  await mailWorker.close();
  await automationWorker.close();
  await mailQueue.close();
  await automationQueue.close();
  process.exit(0);
});

async function main() {
  // Re-adding a repeatable job with the same name + repeat options on
  // every boot is idempotent — BullMQ keys a repeatable job by those, not
  // by a fresh id each time — so this is safe to run on every worker
  // restart.
  await mailQueue.add("process-outbox", {}, { repeat: { every: 15_000 } });
  await automationQueue.add("process-events", {}, { repeat: { every: 5_000 } });
  console.log(`[worker] started, connected to redis at ${env.REDIS_URL}`);
}

main();
