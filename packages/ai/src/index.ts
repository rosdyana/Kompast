import { createAnthropicDriver, createAzureFoundryAnthropicDriver, DEFAULT_ANTHROPIC_MODEL } from "./drivers/anthropic";
import { createAzureOpenAiDriver, createAzureOpenAiEmbeddingsDriver } from "./drivers/azure-openai";
import { createOpenAiCompatibleDriver, createOpenAiCompatibleEmbeddingsDriver } from "./drivers/openai-compatible";
import type { AiCredentials, AiDriver, CompletionRequest, CompletionResult, EmbeddingCredentials, EmbeddingDriver } from "./types";
import { AiProviderError } from "./errors";
export { AiProviderError };

export type {
  AiCredentials,
  AiDriver,
  AiMessage,
  AiToolCall,
  AiToolDefinition,
  CompletionRequest,
  CompletionResult,
  EmbeddingCredentials,
  EmbeddingDriver,
} from "./types";

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
  if (creds.provider === "azure-foundry-anthropic") {
    if (!creds.apiKey) throw new Error("Azure Foundry (Anthropic) requires an API key");
    if (!creds.azureEndpoint) throw new Error("Azure Foundry (Anthropic) requires an endpoint");
    return createAzureFoundryAnthropicDriver(creds.apiKey, creds.azureEndpoint, creds.model);
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
  if (creds.provider === "anthropic" || creds.provider === "azure-foundry-anthropic") return creds.model ?? DEFAULT_ANTHROPIC_MODEL;
  return creds.model ?? "unknown-model";
}

/**
 * OpenAI's text-embedding-3 family (also on Azure) is trained so its vectors can be shortened
 * via the `dimensions` request field with little quality loss, so text-embedding-3-large (3072)
 * fits a 1536 column. Only sent to names matching that family: other models (ada-002, most
 * self-hosted ones) reject the field. On Azure the match is against the deployment name.
 */
export function supportsDimensionsParam(modelOrDeployment: string): boolean {
  return /text-embedding-3/i.test(modelOrDeployment);
}

function createEmbeddingDriver(creds: EmbeddingCredentials, dimensions?: number): EmbeddingDriver {
  if (creds.provider === "azure-openai") {
    if (!creds.apiKey) throw new Error("Azure OpenAI requires an API key");
    if (!creds.azureEndpoint || !creds.azureDeployment) throw new Error("Azure OpenAI requires an endpoint and a deployment name");
    const dims = dimensions && supportsDimensionsParam(creds.azureDeployment) ? dimensions : undefined;
    return createAzureOpenAiEmbeddingsDriver(creds.apiKey, creds.azureEndpoint, creds.azureDeployment, dims);
  }
  if (!creds.apiKey) throw new Error("OpenAI-compatible requires an API key");
  if (!creds.openAiCompatibleBaseUrl) throw new Error("OpenAI-compatible requires a base URL");
  if (!creds.model) throw new Error("OpenAI-compatible requires a model name (no safe default across arbitrary endpoints)");
  const dims = dimensions && supportsDimensionsParam(creds.model) ? dimensions : undefined;
  return createOpenAiCompatibleEmbeddingsDriver(creds.apiKey, creds.openAiCompatibleBaseUrl, creds.model, dims);
}

export interface EmbeddingClient {
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Same "build fresh per call from /settings-driven config" shape as createAiClient — see its own doc comment.
 * `dimensions` is the size the caller stores; it is requested from models that support shortening (supportsDimensionsParam).
 */
export function createEmbeddingClient(creds: EmbeddingCredentials, opts: { dimensions?: number } = {}): EmbeddingClient {
  const driver = createEmbeddingDriver(creds, opts.dimensions);
  return { embed: driver.embed.bind(driver) };
}

export type AiTestResult = { ok: true; model: string; latencyMs: number } | { ok: false; status?: number; message: string };

export type EmbeddingTestResult = { ok: true; model: string; latencyMs: number; dimensions: number } | { ok: false; status?: number; message: string };

/**
 * Turns anything thrown during a test into a result the settings UI can show.
 * A provider HTTP error keeps its status and the provider's own body (the
 * whole point of the test). Anything else (missing fields caught by the driver
 * factory, DNS failure, refused connection) has no status; for network errors
 * the underlying cause is appended, since fetch only says "fetch failed".
 */
function failureFrom(err: unknown): { ok: false; status?: number; message: string } {
  if (err instanceof AiProviderError) {
    return { ok: false, status: err.status, message: err.body || err.message };
  }
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? err.cause.message : undefined;
    return { ok: false, message: cause && cause !== err.message ? `${err.message} (${cause})` : err.message };
  }
  return { ok: false, message: String(err) };
}

/**
 * One tiny completion ("ping", maxTokens 1) through the same driver the real
 * feature calls use, so a passing test means the real path works too. Never
 * throws: every failure comes back as { ok: false }.
 */
export async function testAiConnection(creds: AiCredentials): Promise<AiTestResult> {
  const started = performance.now();
  try {
    const client = createAiClient(creds);
    await client.streamCompletion({ messages: [{ role: "user", content: "ping" }], maxTokens: 1 }, () => {});
    return { ok: true, model: resolveModelName(creds), latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return failureFrom(err);
  }
}

/**
 * Embeds one short string and checks the vector length against the size the
 * column was created with. A model with another dimension passes every HTTP
 * check and then fails on every insert later, so it is reported here instead.
 */
export async function testEmbeddingConnection(creds: EmbeddingCredentials, expectedDimensions: number): Promise<EmbeddingTestResult> {
  const started = performance.now();
  try {
    const client = createEmbeddingClient(creds, { dimensions: expectedDimensions });
    const [vector] = await client.embed(["ping"]);
    const dimensions = vector?.length ?? 0;
    const model = (creds.provider === "azure-openai" ? creds.azureDeployment : creds.model) ?? "unknown-model";
    if (dimensions !== expectedDimensions) {
      return {
        ok: false,
        message: `model returned ${dimensions}-dimensional vectors; Kompast stores ${expectedDimensions} — use a ${expectedDimensions}-dimension model such as text-embedding-3-small, or a text-embedding-3 model (e.g. text-embedding-3-large) whose model/deployment name contains "text-embedding-3" so Kompast can request ${expectedDimensions} dimensions`,
      };
    }
    return { ok: true, model, latencyMs: Math.round(performance.now() - started), dimensions };
  } catch (err) {
    return failureFrom(err);
  }
}
