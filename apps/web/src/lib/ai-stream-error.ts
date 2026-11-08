import { AiNotConfiguredError, EmbeddingNotConfiguredError, ForbiddenError, InvalidInputError, NotFoundError } from "@kompast/core";

/**
 * The text a failed AI stream sends to the browser. Errors written for users
 * (not configured, forbidden, not found) keep their message. Anything else can
 * carry provider response bodies or internals, so it is logged here and the
 * browser gets `fallback`.
 */
export function aiStreamErrorMessage(err: unknown, fallback: string): string {
  if (
    err instanceof AiNotConfiguredError ||
    err instanceof EmbeddingNotConfiguredError ||
    err instanceof ForbiddenError ||
    err instanceof NotFoundError ||
    err instanceof InvalidInputError
  ) {
    return err.message;
  }
  console.error("[ai-stream] request failed:", err);
  return fallback;
}
