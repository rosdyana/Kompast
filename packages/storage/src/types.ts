export interface UploadUrlResult {
  /** Where the client PUTs the file bytes directly. */
  uploadUrl: string;
  /** Headers the client must send with the PUT (e.g. Content-Type). */
  headers: Record<string, string>;
  /** Opaque storage key to persist alongside the attachment row. */
  key: string;
}

export interface StorageDriver {
  /**
   * Issues a short-lived, single-use-in-spirit upload URL for `key`. The
   * caller (packages/core's attachment service) never touches file bytes —
   * the browser PUTs straight to GCS (or to apps/web's local-disk emulation
   * route in dev), keeping the Node process out of the upload path.
   */
  getUploadUrl(key: string, opts: { contentType: string }): Promise<UploadUrlResult>;
  /** Short-lived download URL, issued only after the caller has already checked the requester can see this attachment. */
  getDownloadUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
  /**
   * Writes bytes directly, server-side — for callers that already have the
   * file in hand (packages/import streaming a JIRA/Notion attachment) and
   * have no browser in the loop to hand a signed URL to. Every other path
   * in this codebase (apps/web's own attachment upload flow) deliberately
   * goes through getUploadUrl instead, keeping the Node process out of
   * user-facing upload traffic — this method exists only for that one
   * different, legitimately server-initiated case.
   */
  putObject(key: string, data: Buffer, opts: { contentType: string }): Promise<void>;
}
