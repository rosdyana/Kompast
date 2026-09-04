import { pgTable, text, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import type { Json } from "./_shared";

/**
 * A delivered in-app notification. `eventType` is a free-form dotted key
 * ("issue.assigned", "issue.commented", "page.commented", "sprint.started",
 * ...) rather than an enum — the automation engine (P6) and later event
 * types shouldn't require a migration to register a new one.
 */
export const notification = pgTable(
  "notification",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    entityType: text("entity_type", { enum: ["issue", "page"] }).notNull(),
    entityId: text("entity_id").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("notification_user_idx").on(t.userId), index("notification_org_idx").on(t.organizationId)],
);

/**
 * Per-user, per-workspace, per-event delivery preference — organizationId
 * is included even though the plan's shorthand said "user × event_type",
 * since a user can belong to multiple workspaces (see plan §Tenancy) and
 * may reasonably want different notification behavior in each.
 */
export const notificationPref = pgTable(
  "notification_pref",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    inApp: boolean("in_app").notNull().default(true),
    email: boolean("email").notNull().default(true),
    digest: text("digest", { enum: ["instant", "hourly", "daily", "off"] }).notNull().default("instant"),
  },
  (t) => [uniqueIndex("notification_pref_uq").on(t.organizationId, t.userId, t.eventType)],
);

/**
 * Transactional outbox for outgoing email: enqueueEmail() (packages/core)
 * inserts a row in the SAME transaction as whatever triggered it, so an
 * email is never promised for a mutation that then rolls back. apps/worker
 * is the only reader — it claims pending rows (`FOR UPDATE SKIP LOCKED`,
 * see apps/worker/src/mail-worker.ts) and calls packages/mail. There is no
 * periodic sweep for rows whose post-commit "wake up" BullMQ job never
 * got enqueued (e.g. a crash between commit and enqueue) — a real relay
 * poller is follow-up work, not built this pass; see README.
 */
export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    templateKey: text("template_key").notNull(),
    templateProps: jsonb("template_props").$type<Json>().notNull(),
    status: text("status", { enum: ["pending", "sending", "sent", "failed", "bounced", "complained"] }).notNull().default("pending"),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    sentAt: timestamp("sent_at"),
  },
  (t) => [
    uniqueIndex("email_outbox_dedupe_uq").on(t.organizationId, t.dedupeKey),
    index("email_outbox_status_idx").on(t.status),
  ],
);
