import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadEnv } from "@kompast/env";
import type { StorageDriver, UploadUrlResult } from "./types";

const UPLOAD_URL_TTL_MS = 5 * 60 * 1000;
const DOWNLOAD_URL_TTL_MS = 60 * 1000;

/**
 * Dev/CI-only stand-in for GCS's signed URLs: apps/web exposes
 * /api/storage/{action}/{key} routes (see apps/web/src/routes/api/storage/
 * $.ts) that this driver points at, with the same HMAC-over-{action, key,
 * expires} scheme both sides share via BETTER_AUTH_SECRET. Not meant for a
 * real multi-instance deploy — files live on one container's local disk.
 */
function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Exported for tests that need a real signature for a specific (action, key, expires) triple. */
export function signLocalStorageToken(action: "upload" | "download", key: string, expires: number): string {
  return sign(`${action}:${key}:${expires}`, loadEnv().BETTER_AUTH_SECRET);
}

export function verifyLocalStorageToken(params: {
  action: "upload" | "download";
  key: string;
  expires: number;
  signature: string;
}): boolean {
  const env = loadEnv();
  if (Date.now() > params.expires) return false;
  const expected = sign(`${params.action}:${params.key}:${params.expires}`, env.BETTER_AUTH_SECRET);
  const a = Buffer.from(expected);
  const b = Buffer.from(params.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Resolves a storage key to an on-disk path, rejecting any attempt to escape STORAGE_LOCAL_DIR via `..`. */
export function resolveLocalPath(key: string): string {
  const env = loadEnv();
  const root = resolve(env.STORAGE_LOCAL_DIR);
  const full = resolve(root, key);
  if (full !== root && !full.startsWith(root + "/")) {
    throw new Error(`Refusing to resolve storage key outside STORAGE_LOCAL_DIR: ${key}`);
  }
  return full;
}

export async function ensureLocalDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export function createLocalDriver(): StorageDriver {
  const env = loadEnv();

  function buildUrl(action: "upload" | "download", key: string, ttlMs: number) {
    const expires = Date.now() + ttlMs;
    const signature = sign(`${action}:${key}:${expires}`, env.BETTER_AUTH_SECRET);
    const url = new URL(`/api/storage/${action}/${encodeURIComponent(key)}`, env.APP_URL);
    url.searchParams.set("expires", String(expires));
    url.searchParams.set("signature", signature);
    return url.toString();
  }

  return {
    async getUploadUrl(key, { contentType }): Promise<UploadUrlResult> {
      return {
        uploadUrl: buildUrl("upload", key, UPLOAD_URL_TTL_MS),
        headers: { "Content-Type": contentType },
        key,
      };
    },
    async getDownloadUrl(key) {
      return buildUrl("download", key, DOWNLOAD_URL_TTL_MS);
    },
    async delete(key) {
      // Server-initiated, unlike upload/download — no signed URL needed,
      // packages/storage can touch disk directly for this one operation.
      await rm(resolveLocalPath(key), { force: true });
    },
  };
}
