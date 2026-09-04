import { sql, and, eq, inArray, schema, type Json } from "@kompast/db";
import type { Tx, AnyDb } from "./types";
import { id } from "./ids";

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
 * claiming the same row.
 */
export async function claimPendingEmails(db: AnyDb, limit = 10) {
  const claimed = await db.execute<{ id: string }>(
    sql`update email_outbox set status = 'sending'
        where id in (
          select id from email_outbox where status = 'pending' order by created_at limit ${limit} for update skip locked
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
