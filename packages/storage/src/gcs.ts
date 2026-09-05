import { Storage } from "@google-cloud/storage";
import { loadEnv } from "@kompast/env";
import type { StorageDriver, UploadUrlResult } from "./types";

const UPLOAD_URL_TTL_MS = 5 * 60 * 1000;
const DOWNLOAD_URL_TTL_MS = 60 * 1000;

export function createGcsDriver(): StorageDriver {
  const env = loadEnv();
  if (!env.GCS_BUCKET) throw new Error("GCS_BUCKET is required when STORAGE_DRIVER=gcs");
  const storage = new Storage({ projectId: env.GCS_PROJECT_ID });
  const bucket = storage.bucket(env.GCS_BUCKET);

  return {
    async getUploadUrl(key, { contentType }): Promise<UploadUrlResult> {
      const [uploadUrl] = await bucket.file(key).getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + UPLOAD_URL_TTL_MS,
        contentType,
      });
      // contentType is bound into the signature — the browser's PUT must
      // send this exact header or GCS rejects the request with a 403.
      return { uploadUrl, headers: { "Content-Type": contentType }, key };
    },

    async getDownloadUrl(key) {
      const [downloadUrl] = await bucket.file(key).getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + DOWNLOAD_URL_TTL_MS,
      });
      return downloadUrl;
    },

    async delete(key) {
      await bucket.file(key).delete({ ignoreNotFound: true });
    },

    async putObject(key, data, { contentType }) {
      await bucket.file(key).save(data, { contentType, resumable: false });
    },
  };
}
