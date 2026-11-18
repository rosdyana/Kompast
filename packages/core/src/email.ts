import { sql, and, eq, inArray, schema, type Json } from "@kompast/db";
import type { Tx, AnyDb } from "./types";
import { id } from "./ids";

/** A row claimed ("sending") longer ago than this is assumed abandoned by a dead worker and is claimed again. */
export const EMAIL_CLAIM_STALE_MINUTES = 10;
/** Delivery attempts before a row fails for good. Backoff doubles from 2 minutes: 2, 4, 8, 16, 32. */
export const MAX_EMAIL_ATTEMPTS = 6;

export interface EnqueueEmailInput {
  organizationId: string;
  to: string;
  subject: string;
  templateKey: string;
  templateProps: Json;
  /** Scoped to the organization — see email_outbox's unique index. Callers pick something stable per logical send, e.g. `notification:<notificationId>`, so a retried caller doesn't queue a duplicate. */
  dedupeKey: string;
}

/**
 * Writes an outbox row in the SAME transaction as whatever triggered the
 * email (see packages/db/src/schema/notification.ts's module doc) —
 * never call this outside a real mutation's transaction, or a rollback
 * would leave a promised email with nothing that actually happened.
 */
export async function enqueueEmail(tx: Tx, input: EnqueueEmailInput): Promise<{ outboxId: string; deduped: boolean }> {
  const outboxId = id("outbox");
  const [inserted] = await tx
    .insert(schema.emailOutbox)
    .values({
      id: outboxId,
      organizationId: input.organizationId,
      toEmail: input.to,
      subject: input.subject,
      templateKey: input.templateKey,
      templateProps: input.templateProps,
      dedupeKey: input.dedupeKey,
    })
    .onConflictDoNothing({ target: [schema.emailOutbox.organizationId, schema.emailOutbox.dedupeKey] })
    .returning({ id: schema.emailOutbox.id });

  if (inserted) return { outboxId: inserted.id, deduped: false };

  const [existing] = await tx
    .select({ id: schema.emailOutbox.id })
    .from(schema.emailOutbox)
    .where(and(eq(schema.emailOutbox.organizationId, input.organizationId), eq(schema.emailOutbox.dedupeKey, input.dedupeKey)));
  return { outboxId: existing!.id, deduped: true };
}

/**
 * Claims up to `limit` pending rows across every workspace in one go —
 * this is apps/worker's system-wide scan, not one tenant's request, so
 * `db` MUST be the admin connection (bypasses RLS by role, same as
 * apps/collab and the guest share-link route — see rls.sql). `FOR UPDATE
 * SKIP LOCKED` lets more than one worker process run without both
 * claiming the same row. Also reclaims rows whose "sending" claim went stale
 * (a worker died mid-send) and honours retry backoff after a failed attempt.
 */
export async function claimPendingEmails(db: AnyDb, limit = 10) {
  const claimed = await db.execute<{ id: string }>(
    sql`update email_outbox set status = 'sending', claimed_at = now()
        where id in (
          select id from email_outbox
          where (status = 'pending'
                 and (attempts = 0 or claimed_at is null
                      or claimed_at <= now() - make_interval(mins => (2 ^ least(attempts, 6))::int)))
             or (status = 'sending' and claimed_at < now() - make_interval(mins => ${EMAIL_CLAIM_STALE_MINUTES}))
          order by created_at limit ${limit} for update skip locked
        )
        returning id`,
  );
  const ids = claimed.map((r) => r.id);
  if (ids.length === 0) return [];
  return db.select().from(schema.emailOutbox).where(inArray(schema.emailOutbox.id, ids));
}

export async function markEmailSent(db: AnyDb, outboxId: string, providerMessageId: string) {
  await db.update(schema.emailOutbox).set({ status: "sent", providerMessageId, sentAt: new Date() }).where(eq(schema.emailOutbox.id, outboxId));
}

export async function markEmailFailed(db: AnyDb, outboxId: string, error: string) {
  await db.update(schema.emailOutbox).set({ status: "failed", error }).where(eq(schema.emailOutbox.id, outboxId));
}

/**
 * Records one failed delivery attempt. The row goes back to "pending" (to be
 * retried after a backoff, see claimPendingEmails) until MAX_EMAIL_ATTEMPTS
 * is reached, then fails for good. Returns the resulting status.
 */
export async function recordEmailFailure(db: AnyDb, outboxId: string, error: string): Promise<"pending" | "failed"> {
  const rows = await db.execute<{ status: "pending" | "failed" }>(
    sql`update email_outbox
        set attempts = attempts + 1,
            error = ${error},
            claimed_at = now(),
            status = case when attempts + 1 >= ${MAX_EMAIL_ATTEMPTS} then 'failed' else 'pending' end
        where id = ${outboxId}
        returning status`,
  );
  return rows[0]?.status ?? "failed";
}

/**
 * What a user should be told about one outbox row, derived from its stored
 * status + error (not from attempts alone — markEmailFailed sets "failed"
 * directly):
 * - sent: delivered to the vendor.
 * - failing: a delivery attempt failed, `error` is set, and the row will be retried.
 * - failed: retries exhausted (or marked failed); `error` is the last failure.
 * - queued: not attempted yet (or a worker currently holds it with no prior error).
 */
export type EmailDeliveryState = "sent" | "failing" | "failed" | "queued";

export interface EmailDelivery {
  state: EmailDeliveryState;
  error: string | null;
  attempts: number;
}

function deriveEmailDelivery(row: { status: string; error: string | null; attempts: number }): EmailDelivery {
  const attempts = row.attempts;
  if (row.status === "sent") return { state: "sent", error: null, attempts };
  // bounced/complained are never produced by this app today; treat them as terminal failures if they ever appear.
  if (row.status === "failed" || row.status === "bounced" || row.status === "complained") return { state: "failed", error: row.error, attempts };
  // pending | sending
  if (row.error) return { state: "failing", error: row.error, attempts };
  return { state: "queued", error: null, attempts };
}

/** Delivery state of one outbox row, or null if no such row exists. Tenant-scoped: call inside withAuthorizedTenant. */
export async function getEmailDelivery(tx: Tx, outboxId: string): Promise<EmailDelivery | null> {
  const [row] = await tx
    .select({ status: schema.emailOutbox.status, error: schema.emailOutbox.error, attempts: schema.emailOutbox.attempts })
    .from(schema.emailOutbox)
    .where(eq(schema.emailOutbox.id, outboxId));
  return row ? deriveEmailDelivery(row) : null;
}

/**
 * Batch lookup by dedupeKey (e.g. `invitation:<id>`), keyed by dedupeKey.
 * Keys with no outbox row are simply absent from the map. Tenant-scoped: call inside withAuthorizedTenant.
 */
export async function getEmailDeliveryByDedupeKeys(tx: Tx, organizationId: string, dedupeKeys: string[]): Promise<Map<string, EmailDelivery>> {
  const result = new Map<string, EmailDelivery>();
  if (dedupeKeys.length === 0) return result;
  const rows = await tx
    .select({
      dedupeKey: schema.emailOutbox.dedupeKey,
      status: schema.emailOutbox.status,
      error: schema.emailOutbox.error,
      attempts: schema.emailOutbox.attempts,
    })
    .from(schema.emailOutbox)
    .where(and(eq(schema.emailOutbox.organizationId, organizationId), inArray(schema.emailOutbox.dedupeKey, dedupeKeys)));
  for (const row of rows) result.set(row.dedupeKey, deriveEmailDelivery(row));
  return result;
}

/**
 * Puts an existing outbox row (by dedupeKey) back into the queue: pending,
 * attempts 0, no error, no claim, so the next worker poll sends it again.
 * Returns false when no such row exists. Tenant-scoped: call inside withAuthorizedTenant.
 */
export async function retryEmail(tx: Tx, organizationId: string, dedupeKey: string): Promise<boolean> {
  // A worker holding the row mid-send must not be reset under it (that would double-send);
  // report it as existing so the caller doesn't enqueue a fresh copy either.
  const [current] = await tx
    .select({ status: schema.emailOutbox.status })
    .from(schema.emailOutbox)
    .where(and(eq(schema.emailOutbox.organizationId, organizationId), eq(schema.emailOutbox.dedupeKey, dedupeKey)));
  if (!current) return false;
  if (current.status === "sending") return true;
  const rows = await tx
    .update(schema.emailOutbox)
    .set({ status: "pending", attempts: 0, error: null, claimedAt: null })
    .where(and(eq(schema.emailOutbox.organizationId, organizationId), eq(schema.emailOutbox.dedupeKey, dedupeKey)))
    .returning({ id: schema.emailOutbox.id });
  return rows.length > 0;
}

export interface SendSprintSummaryEmailInput {
  organizationId: string;
  sprintId: string;
  recipients: string[];
  subject: string;
  body: string;
}

export interface SendSprintSummaryEmailResult {
  sent: number;
  deduped: number;
}

/**
 * Composes-and-sends the sprint AI summary by email — one email_outbox row
 * per recipient, all sharing a fresh per-call id in their dedupeKey so a
 * single "Send" click can't double-queue an email on retry, but a later,
 * deliberate re-send (a fresh call) isn't deduped away by an earlier send's
 * key.
 */
export async function sendSprintSummaryEmail(tx: Tx, input: SendSprintSummaryEmailInput): Promise<SendSprintSummaryEmailResult> {
  if (input.recipients.length === 0) throw new Error("At least one recipient is required");

  const sendId = id("sprintsummarysend");
  let sent = 0;
  let deduped = 0;
  for (const to of input.recipients) {
    const result = await enqueueEmail(tx, {
      organizationId: input.organizationId,
      to,
      subject: input.subject,
      templateKey: "sprint-summary",
      templateProps: { subject: input.subject, body: input.body },
      dedupeKey: `sprint-summary:${input.sprintId}:${sendId}:${to}`,
    });
    if (result.deduped) deduped++;
    else sent++;
  }
  return { sent, deduped };
}
