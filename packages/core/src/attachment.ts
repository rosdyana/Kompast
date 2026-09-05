import { eq, and, schema } from "@kompast/db";
import { getStorageDriver } from "@kompast/storage";
import type { Tx } from "./types";
import { id } from "./ids";

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
}

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
  const key = `issue-attachments/${input.issueId}/${attachmentId}-${sanitizeFileName(input.fileName)}`;
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
  const key = `issue-attachments/${input.issueId}/${attachmentId}-${sanitizeFileName(input.fileName)}`;
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

export async function listAttachments(tx: Tx, issueId: string) {
  const rows = await tx.select().from(schema.issueAttachment).where(eq(schema.issueAttachment.issueId, issueId));
  const driver = getStorageDriver();
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      downloadUrl: await driver.getDownloadUrl(row.storageKey),
    })),
  );
}

export async function deleteAttachment(tx: Tx, params: { attachmentId: string; issueId: string }) {
  const [row] = await tx
    .select()
    .from(schema.issueAttachment)
    .where(and(eq(schema.issueAttachment.id, params.attachmentId), eq(schema.issueAttachment.issueId, params.issueId)));
  if (!row) throw new Error(`Attachment ${params.attachmentId} not found on issue ${params.issueId}`);

  await getStorageDriver().delete(row.storageKey);
  await tx.delete(schema.issueAttachment).where(eq(schema.issueAttachment.id, params.attachmentId));
}
