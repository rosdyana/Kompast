import { and, asc, eq, schema, sql } from "@kompast/db";
import { getStorageDriver } from "@kompast/storage";
import type { Tx } from "./types";
import { id } from "./ids";

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
}

/** The storage key of an attachment's bytes. Same format for every writer (UI upload, one-shot importer, migration copy). */
export function attachmentStorageKey(issueId: string, attachmentId: string, fileName: string): string {
  return `issue-attachments/${issueId}/${attachmentId}-${sanitizeFileName(fileName)}`;
}

/** Copy attempts for a JIRA migration file before it is marked failed for good. */
export const IMPORT_ATTACHMENT_MAX_ATTEMPTS = 3;

export interface RequestAttachmentUploadInput {
  issueId: string;
  uploaderId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * Creates the attachment row up front (optimistic) and hands back a signed
 * URL the BROWSER uploads directly to — the Node process never sees file
 * bytes, in either storage driver. There's no completion webhook in this
 * v1: if the client-side PUT never finishes, the row exists without a
 * matching object. Acceptable for now; a cleanup sweep is a P9-hardening
 * concern, not a P1 one.
 */
export async function requestAttachmentUpload(tx: Tx, input: RequestAttachmentUploadInput) {
  const attachmentId = id("attach");
  const key = attachmentStorageKey(input.issueId, attachmentId, input.fileName);
  const driver = getStorageDriver();
  const { uploadUrl, headers } = await driver.getUploadUrl(key, { contentType: input.contentType });

  await tx.insert(schema.issueAttachment).values({
    id: attachmentId,
    issueId: input.issueId,
    uploaderId: input.uploaderId,
    storageKey: key,
    fileName: input.fileName,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
  });

  return { attachmentId, uploadUrl, headers };
}

export interface AttachIssueFileInput {
  issueId: string;
  uploaderId: string;
  fileName: string;
  contentType: string;
  data: Buffer;
}

/**
 * Server-side counterpart to requestAttachmentUpload — for a caller that
 * already has the file bytes in hand (the importer, streaming a JIRA/
 * Notion attachment straight from the source API) and has no browser to
 * hand a signed URL to. Writes directly via StorageDriver.putObject
 * instead of issuing an upload URL.
 */
export async function attachIssueFile(tx: Tx, input: AttachIssueFileInput) {
  const attachmentId = id("attach");
  const key = attachmentStorageKey(input.issueId, attachmentId, input.fileName);
  const driver = getStorageDriver();
  await driver.putObject(key, input.data, { contentType: input.contentType });

  await tx.insert(schema.issueAttachment).values({
    id: attachmentId,
    issueId: input.issueId,
    uploaderId: input.uploaderId,
    storageKey: key,
    fileName: input.fileName,
    contentType: input.contentType,
    sizeBytes: input.data.byteLength,
  });

  return { attachmentId };
}

// ── JIRA migration: placeholders, then copies ───────────────────────────────
//
// The migration's data phase writes a row per JIRA attachment with no bytes
// (status pending or not_migrated). The attachments phase copies each pending
// file outside any transaction, then records the result here in a short tx.

export interface RecordImportedAttachmentPlaceholderInput {
  issueId: string;
  uploaderId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  status: "pending" | "not_migrated";
  /** The JIRA page for the file: `<site>/secure/attachment/<id>/<name>`. */
  sourceUrl: string;
  /** JIRA's created time for the file. */
  createdAt: Date;
}

/** Writes a placeholder row for a JIRA attachment. No bytes, no storage I/O: the caller writes the external_ref. */
export async function recordImportedAttachmentPlaceholder(tx: Tx, input: RecordImportedAttachmentPlaceholderInput): Promise<{ attachmentId: string }> {
  const attachmentId = id("attach");
  await tx.insert(schema.issueAttachment).values({
    id: attachmentId,
    issueId: input.issueId,
    uploaderId: input.uploaderId,
    storageKey: null,
    status: input.status,
    sourceUrl: input.sourceUrl,
    fileName: input.fileName,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    createdAt: input.createdAt,
  });
  return { attachmentId };
}

export interface PutImportedAttachmentBytesInput {
  issueId: string;
  attachmentId: string;
  fileName: string;
  contentType: string;
  data: Buffer;
}

/**
 * Writes a migrated file's bytes to storage under the attachment's own key, and
 * returns that key. Outside any transaction: the caller records the key with
 * markImportedAttachmentStored afterwards.
 */
export async function putImportedAttachmentBytes(input: PutImportedAttachmentBytesInput): Promise<{ storageKey: string }> {
  const storageKey = attachmentStorageKey(input.issueId, input.attachmentId, input.fileName);
  await getStorageDriver().putObject(storageKey, input.data, { contentType: input.contentType });
  return { storageKey };
}

export interface MarkImportedAttachmentStoredInput {
  attachmentId: string;
  storageKey: string;
  sizeBytes: number;
  contentType: string;
}

/** The copy succeeded: the row now points at its bytes. */
export async function markImportedAttachmentStored(tx: Tx, input: MarkImportedAttachmentStoredInput): Promise<void> {
  await tx
    .update(schema.issueAttachment)
    .set({ storageKey: input.storageKey, status: "stored", sizeBytes: input.sizeBytes, contentType: input.contentType, error: null })
    .where(eq(schema.issueAttachment.id, input.attachmentId));
}

export interface MarkImportedAttachmentFailedInput {
  attachmentId: string;
  error: string;
  /** A failure that retrying can't fix (JIRA says the attachment is gone). Fails the row at once. */
  permanent?: boolean;
}

/**
 * Records a failed copy attempt. The attempt count goes up; the row stays
 * pending until IMPORT_ATTACHMENT_MAX_ATTEMPTS, then becomes failed. A
 * permanent failure becomes failed at once. Returns the row's new status.
 */
export async function markImportedAttachmentFailed(tx: Tx, input: MarkImportedAttachmentFailedInput): Promise<{ status: "pending" | "failed"; attempts: number }> {
  const [row] = await tx
    .update(schema.issueAttachment)
    .set({ attempts: sql`${schema.issueAttachment.attempts} + 1`, error: input.error })
    .where(eq(schema.issueAttachment.id, input.attachmentId))
    .returning({ attempts: schema.issueAttachment.attempts });
  if (!row) throw new Error(`Attachment ${input.attachmentId} not found`);
  const status = input.permanent || row.attempts >= IMPORT_ATTACHMENT_MAX_ATTEMPTS ? "failed" : "pending";
  await tx.update(schema.issueAttachment).set({ status }).where(eq(schema.issueAttachment.id, input.attachmentId));
  return { status, attempts: row.attempts };
}

/**
 * Re-queues this project's failed copies (attempts reset, error cleared) for a
 * re-run. Stored files are not touched. Returns how many rows were re-queued.
 */
export async function requeueFailedImportedAttachments(tx: Tx, projectId: string): Promise<number> {
  const rows = await tx
    .update(schema.issueAttachment)
    .set({ status: "pending", attempts: 0, error: null })
    .where(
      and(
        eq(schema.issueAttachment.status, "failed"),
        sql`${schema.issueAttachment.issueId} in (select ${schema.issue.id} from ${schema.issue} where ${schema.issue.projectId} = ${projectId})`,
      ),
    )
    .returning({ id: schema.issueAttachment.id });
  return rows.length;
}

export interface ImportedAttachmentSummary {
  /** Rows per status across the project's issues. */
  counts: { stored: number; pending: number; not_migrated: number; failed: number };
  /** Bytes per status group: stored, and every copyable row (stored, pending or failed). */
  bytesStored: number;
  bytesCopyable: number;
}

/** Counts and byte totals of the project's attachments, for the migration's progress. Reads only. */
export async function summarizeImportedAttachments(tx: Tx, projectId: string): Promise<ImportedAttachmentSummary> {
  const rows = await tx
    .select({
      status: schema.issueAttachment.status,
      n: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${schema.issueAttachment.sizeBytes}), 0)::float8`,
    })
    .from(schema.issueAttachment)
    .innerJoin(schema.issue, eq(schema.issue.id, schema.issueAttachment.issueId))
    .where(eq(schema.issue.projectId, projectId))
    .groupBy(schema.issueAttachment.status);

  const summary: ImportedAttachmentSummary = { counts: { stored: 0, pending: 0, not_migrated: 0, failed: 0 }, bytesStored: 0, bytesCopyable: 0 };
  for (const row of rows) {
    summary.counts[row.status] = row.n;
    if (row.status === "stored") summary.bytesStored += Number(row.bytes);
    if (row.status === "stored" || row.status === "pending" || row.status === "failed") summary.bytesCopyable += Number(row.bytes);
  }
  return summary;
}

export interface PendingImportedAttachment {
  attachmentId: string;
  issueId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** The JIRA page for the file: the link a not-copied file falls back to. */
  sourceUrl: string | null;
  /** JIRA's attachment id, from the external_ref. Null if the ref is missing (the copy then fails for good). */
  jiraAttachmentId: string | null;
  /** The JIRA issue key the attachment belongs to. */
  jiraIssueKey: string | null;
}

/** The next pending copies of a project, oldest first. */
export async function listPendingImportedAttachments(tx: Tx, projectId: string, limit: number): Promise<PendingImportedAttachment[]> {
  const rows = await tx
    .select({
      attachmentId: schema.issueAttachment.id,
      issueId: schema.issueAttachment.issueId,
      fileName: schema.issueAttachment.fileName,
      contentType: schema.issueAttachment.contentType,
      sizeBytes: schema.issueAttachment.sizeBytes,
      sourceUrl: schema.issueAttachment.sourceUrl,
      sourceId: schema.externalRef.sourceId,
    })
    .from(schema.issueAttachment)
    .innerJoin(schema.issue, eq(schema.issue.id, schema.issueAttachment.issueId))
    .leftJoin(
      schema.externalRef,
      and(eq(schema.externalRef.entityId, schema.issueAttachment.id), eq(schema.externalRef.entityType, "attachment"), eq(schema.externalRef.source, "jira")),
    )
    .where(and(eq(schema.issue.projectId, projectId), eq(schema.issueAttachment.status, "pending")))
    .orderBy(asc(schema.issueAttachment.createdAt), asc(schema.issueAttachment.id))
    .limit(limit);

  return rows.map((r) => {
    // The ref's source id is "<JIRA issue key>/<JIRA attachment id>".
    const slash = r.sourceId ? r.sourceId.lastIndexOf("/") : -1;
    return {
      attachmentId: r.attachmentId,
      issueId: r.issueId,
      fileName: r.fileName,
      contentType: r.contentType,
      sizeBytes: r.sizeBytes,
      sourceUrl: r.sourceUrl,
      jiraAttachmentId: slash >= 0 ? r.sourceId!.slice(slash + 1) : null,
      jiraIssueKey: slash >= 0 ? r.sourceId!.slice(0, slash) : null,
    };
  });
}

export async function listAttachments(tx: Tx, issueId: string) {
  const rows = await tx.select().from(schema.issueAttachment).where(eq(schema.issueAttachment.issueId, issueId));
  const driver = getStorageDriver();
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      // A placeholder (a JIRA file not copied yet, or not copied at all) has no bytes to download.
      downloadUrl: row.storageKey ? await driver.getDownloadUrl(row.storageKey) : null,
    })),
  );
}

export async function deleteAttachment(tx: Tx, params: { attachmentId: string; issueId: string }) {
  const [row] = await tx
    .select()
    .from(schema.issueAttachment)
    .where(and(eq(schema.issueAttachment.id, params.attachmentId), eq(schema.issueAttachment.issueId, params.issueId)));
  if (!row) throw new Error(`Attachment ${params.attachmentId} not found on issue ${params.issueId}`);

  // A placeholder has no bytes in storage, so there is nothing to delete there.
  if (row.storageKey) await getStorageDriver().delete(row.storageKey);
  await tx.delete(schema.issueAttachment).where(eq(schema.issueAttachment.id, params.attachmentId));
}
