export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: AiMessage[];
  maxTokens?: number;
}

export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
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
  provider: "anthropic" | "azure-openai" | "openai-compatible";
  apiKey: string | null;
  /** Ignored for azure-openai (the deployment name in azureDeployment selects the model instead). Required for openai-compatible — no safe default across arbitrary endpoints. Optional for anthropic (falls back to a current default model). */
  model: string | null;
  azureEndpoint: string | null;
  azureDeployment: string | null;
  openAiCompatibleBaseUrl: string | null;
}
