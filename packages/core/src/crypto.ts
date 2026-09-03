import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { loadEnv } from "@kompast/env";

/**
 * Secrets that live in system_settings (Microsoft client secret, AI/mail
 * API keys) are encrypted at rest with a key derived from
 * BETTER_AUTH_SECRET — not a full KMS/envelope-encryption setup, but
 * meaningfully better than plaintext in the database for a leaked-dump
 * scenario, reusing a secret every deployment already has to provision.
 * Revisit with a real KMS if that ever becomes the actual threat model
 * (see plan §Verification, P9 hardening).
 */
function getKey(): Buffer {
  const env = loadEnv();
  return createHash("sha256").update(env.BETTER_AUTH_SECRET).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(stored: string): string {
  const [ivB64, authTagB64, dataB64] = stored.split(".");
  if (!ivB64 || !authTagB64 || !dataB64) throw new Error("Malformed encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}
