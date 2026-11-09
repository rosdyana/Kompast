import { loadEnv } from "@kompast/env";
import { createGcsDriver } from "./gcs";
import { createLocalDriver } from "./local";
import type { StorageDriver } from "./types";

export type { StorageDriver, UploadUrlResult } from "./types";
export { MAX_UPLOAD_BYTES } from "./limits";
export { verifyLocalStorageToken, signLocalStorageToken, resolveLocalPath, ensureLocalDir } from "./local";
export { contentTypeFor } from "./content-type";

let cached: StorageDriver | undefined;

export function getStorageDriver(): StorageDriver {
  if (cached) return cached;
  const env = loadEnv();
  cached = env.STORAGE_DRIVER === "gcs" ? createGcsDriver() : createLocalDriver();
  return cached;
}
