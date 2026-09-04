import { loadEnv } from "@kompast/env";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { adminDb } from "@kompast/db";
import { claimPendingEmails, markEmailSent, markEmailFailed, getMailCredentials } from "@kompast/core";
import { createMailer, NotificationEmail } from "@kompast/mail";

const env = loadEnv();
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const MAIL_QUEUE = "mail";

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

const mailQueue = new Queue(MAIL_QUEUE, { connection });
const worker = new Worker(MAIL_QUEUE, () => processOutboxBatch(), { connection });
worker.on("failed", (job, err) => console.error(`[worker] mail job ${job?.id} failed:`, err));

process.on("SIGTERM", async () => {
  await worker.close();
  await mailQueue.close();
  process.exit(0);
});

async function main() {
  // Re-adding a repeatable job with the same name + repeat options on
  // every boot is idempotent — BullMQ keys a repeatable job by those, not
  // by a fresh id each time — so this is safe to run on every worker
  // restart.
  await mailQueue.add("process-outbox", {}, { repeat: { every: 15_000 } });
  console.log(`[worker] started, connected to redis at ${env.REDIS_URL}`);
}

main();
