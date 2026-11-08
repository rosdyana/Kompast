/**
 * Largest single file a user can upload (issue attachments). Enforced three
 * places: the signed upload URL (GCS content-length-range), the local-disk
 * upload route (Content-Length check plus a byte counter), and the request
 * schema that asks for the URL.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
