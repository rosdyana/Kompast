import { getStorageDriver } from "./index";
import { contentTypeFor } from "./content-type";

/**
 * Stores a page's file (an imported image or attachment) and returns the
 * URL the doc should point at. /api/page-assets checks the reader can see
 * the page before handing out a short-lived storage URL, so the asset is
 * exactly as private as the page.
 *
 * Lives behind the `@kompast/storage/page-assets` subpath rather than the
 * index: it calls getStorageDriver through the index, and a re-export from
 * the index would make that a cycle.
 */
export async function putPageAsset(pageId: string, fileName: string, data: Uint8Array, contentType?: string): Promise<string> {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "file";
  const name = `${crypto.randomUUID().slice(0, 8)}-${safeName}`;
  await getStorageDriver().putObject(`page-assets/${pageId}/${name}`, Buffer.from(data), { contentType: contentType ?? contentTypeFor(name) });
  return `/api/page-assets/${pageId}/${encodeURIComponent(name)}`;
}
