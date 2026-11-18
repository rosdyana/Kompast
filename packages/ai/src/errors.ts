/** Longest provider response body kept on the error. Enough for a JSON error envelope, short enough that a hostile or huge body can't bloat logs or the settings UI. */
const MAX_BODY_CHARS = 500;

/**
 * A non-OK response from an AI or embedding provider. Carries the HTTP status
 * and a bounded copy of the provider's own response body, so an admin-facing
 * "Test connection" can show the real cause (wrong deployment name, bad key,
 * quota) instead of a generic failure. `message` keeps the same text the
 * drivers always threw, so existing logs don't change.
 */
export class AiProviderError extends Error {
  readonly status: number;
  /** Human label of the driver that failed, e.g. "Anthropic" or "Azure Foundry (Anthropic)". */
  readonly provider: string;
  /** The provider's response body, trimmed and capped at MAX_BODY_CHARS. */
  readonly body: string;
  /** Which settings the failure belongs to: the chat model (Settings → AI) or the embedding model (Settings → Embedding). */
  readonly kind: "chat" | "embedding";

  constructor(message: string, input: { status: number; provider: string; detail: string; kind?: "chat" | "embedding" }) {
    super(message);
    this.name = "AiProviderError";
    this.status = input.status;
    this.provider = input.provider;
    this.body = input.detail.trim().slice(0, MAX_BODY_CHARS);
    this.kind = input.kind ?? "chat";
  }
}
