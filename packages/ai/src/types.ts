/** A tool the model may call. `inputSchema` is a JSON Schema object describing the tool's input. */
export interface AiToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One tool invocation the model asked for. `id` pairs it with the `role: "tool"` result that answers it. */
export interface AiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * The plain `{role, content}` shape every existing caller uses is still the
 * first union member, so those call sites compile unchanged. The other two
 * members exist only for the tool-calling loop: an assistant turn that
 * requested tools, and the result message that answers one of those requests.
 */
export type AiMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: string; toolCalls: AiToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface CompletionRequest {
  messages: AiMessage[];
  maxTokens?: number;
  tools?: AiToolDefinition[];
}

export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Empty unless the model asked for tools. */
  toolCalls: AiToolCall[];
  /** "tool_use" when the model stopped to request tools, otherwise "end". */
  stopReason: "end" | "tool_use";
}

export interface AiDriver {
  /**
   * Streams the completion, invoking onDelta for each text chunk as it
   * arrives, and resolves with the full text + token usage once the
   * provider's stream ends.
   */
  streamCompletion(input: CompletionRequest, onDelta: (delta: string) => void): Promise<CompletionResult>;
}

/**
 * Decrypted AI credentials — the shape packages/core's getAiCredentials()
 * returns. Mirrors packages/mail's MailCredentials: this package doesn't
 * depend on @kompast/core/@kompast/db itself, so the /settings-driven
 * config-resolution boundary stays in one place.
 */
export interface AiCredentials {
  provider: "anthropic" | "azure-openai" | "azure-foundry-anthropic" | "openai-compatible";
  apiKey: string | null;
  /** For azure-foundry-anthropic this is the Foundry deployment name (optional — falls back to the default Claude model ID, which is also Foundry's default deployment name); its endpoint reuses azureEndpoint. Ignored for azure-openai (the deployment name in azureDeployment selects the model instead). Required for openai-compatible — no safe default across arbitrary endpoints. Optional for anthropic (falls back to a current default model). */
  model: string | null;
  azureEndpoint: string | null;
  azureDeployment: string | null;
  openAiCompatibleBaseUrl: string | null;
}

/**
 * Deliberately a separate credentials shape from AiCredentials, not a
 * reuse of it — Anthropic (a valid AiCredentials provider) has no public
 * embeddings API at all, so "the workspace's AI provider" and "the
 * workspace's embedding provider" are independent choices in /settings,
 * not the same setting doing double duty.
 */
export interface EmbeddingCredentials {
  provider: "azure-openai" | "openai-compatible";
  apiKey: string | null;
  model: string | null;
  azureEndpoint: string | null;
  azureDeployment: string | null;
  openAiCompatibleBaseUrl: string | null;
}

export interface EmbeddingDriver {
  /** One embedding vector per input string, same order as `texts`. */
  embed(texts: string[]): Promise<number[][]>;
}
