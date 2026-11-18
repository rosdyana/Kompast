import { AiNotConfiguredError, AiProviderError, EmbeddingNotConfiguredError, ForbiddenError, InvalidInputError, NotFoundError } from "@kompast/core";

export interface AiStreamErrorContext {
  /** Whether the caller is the deployment admin (see isDeploymentAdmin in @kompast/core). Only they get the provider's HTTP status pointed at Settings. */
  isDeploymentAdmin: boolean;
}

/**
 * The text a failed AI stream sends to the browser. Errors written for users
 * (not configured, forbidden, not found) keep their message. Anything else can
 * carry provider response bodies or internals, so it is logged here and the
 * browser gets `fallback`.
 *
 * A deployment admin also gets the HTTP status of a provider failure, with a
 * pointer to Settings → AI → Test connection, which shows the full body. The
 * body itself never goes to the browser, and everyone else gets the fallback
 * alone. The full error is logged either way.
 */
export function aiStreamErrorMessage(err: unknown, fallback: string, ctx?: AiStreamErrorContext): string {
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
  if (ctx?.isDeploymentAdmin && err instanceof AiProviderError) {
    // Ask Kompast calls both providers; point at the one that actually failed.
    const section = err.kind === "embedding" ? "Embedding" : "AI";
    return `${fallback} (HTTP ${err.status} — open Settings → ${section} and use "Test connection" for details)`;
  }
  return fallback;
}
