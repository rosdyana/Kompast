import { createAnthropicDriver, DEFAULT_ANTHROPIC_MODEL } from "./drivers/anthropic";
import { createAzureOpenAiDriver } from "./drivers/azure-openai";
import { createOpenAiCompatibleDriver } from "./drivers/openai-compatible";
import type { AiCredentials, AiDriver, CompletionRequest, CompletionResult } from "./types";

export type { AiCredentials, AiDriver, AiMessage, CompletionRequest, CompletionResult } from "./types";

function createDriver(creds: AiCredentials): AiDriver {
  if (creds.provider === "anthropic") {
    if (!creds.apiKey) throw new Error("Anthropic requires an API key");
    return createAnthropicDriver(creds.apiKey, creds.model);
  }
  if (creds.provider === "azure-openai") {
    if (!creds.apiKey) throw new Error("Azure OpenAI requires an API key");
    if (!creds.azureEndpoint || !creds.azureDeployment) throw new Error("Azure OpenAI requires an endpoint and a deployment name");
    return createAzureOpenAiDriver(creds.apiKey, creds.azureEndpoint, creds.azureDeployment);
  }
  if (!creds.apiKey) throw new Error("OpenAI-compatible requires an API key");
  if (!creds.openAiCompatibleBaseUrl) throw new Error("OpenAI-compatible requires a base URL");
  if (!creds.model) throw new Error("OpenAI-compatible requires a model name (no safe default across arbitrary endpoints)");
  return createOpenAiCompatibleDriver(creds.apiKey, creds.openAiCompatibleBaseUrl, creds.model);
}

export interface AiClient {
  streamCompletion(input: CompletionRequest, onDelta: (delta: string) => void): Promise<CompletionResult>;
}

/**
 * Mirrors packages/mail's createMailer(creds) — build a fresh client per
 * call from admin-editable /settings config rather than a module-level
 * singleton, since the provider/key/model can change at runtime.
 */
export function createAiClient(creds: AiCredentials): AiClient {
  const driver = createDriver(creds);
  return { streamCompletion: driver.streamCompletion.bind(driver) };
}

/**
 * The model name actually used for a given credentials set — for callers
 * (packages/core's ai_usage logging) that need to record what was called
 * without duplicating each driver's own defaulting/selection logic.
 * Azure's "model" is really its deployment name; openai-compatible has no
 * safe default (createAiClient already throws before this would matter).
 */
export function resolveModelName(creds: AiCredentials): string {
  if (creds.provider === "azure-openai") return creds.azureDeployment ?? "unknown-deployment";
  if (creds.provider === "anthropic") return creds.model ?? DEFAULT_ANTHROPIC_MODEL;
  return creds.model ?? "unknown-model";
}
