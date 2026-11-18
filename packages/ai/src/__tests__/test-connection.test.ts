import { afterEach, describe, expect, it, vi } from "vitest";
import { AiProviderError, testAiConnection, testEmbeddingConnection } from "../index";
import { createAnthropicDriver } from "../drivers/anthropic";
import { createOpenAiEmbeddingsDriver } from "../drivers/openai-embeddings";
import type { AiCredentials, EmbeddingCredentials } from "../types";

const anthropicCreds: AiCredentials = {
  provider: "anthropic",
  apiKey: "sk-test",
  model: "claude-haiku-5-5",
  azureEndpoint: null,
  azureDeployment: null,
  openAiCompatibleBaseUrl: null,
};

const embeddingCreds: EmbeddingCredentials = {
  provider: "openai-compatible",
  apiKey: "embed-key",
  model: "text-embedding-3-small",
  azureEndpoint: null,
  azureDeployment: null,
  openAiCompatibleBaseUrl: "https://llm.test/v1",
};

function anthropicStream(): Response {
  const frames = [
    { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "p" } },
    { type: "message_delta", usage: { output_tokens: 1 } },
  ];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function embeddingVectors(length: number): Response {
  return new Response(JSON.stringify({ data: [{ embedding: new Array(length).fill(0.1), index: 0 }] }), { status: 200 });
}

describe("testAiConnection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports ok with the model name and latency on a successful ping", async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicStream());
    vi.stubGlobal("fetch", fetchMock);

    const result = await testAiConnection(anthropicCreds);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe("claude-haiku-5-5");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    const [, init] = fetchMock.mock.calls[0]!;
    const sent = JSON.parse(init.body);
    expect(sent.max_tokens).toBe(1);
    expect(sent.messages).toEqual([{ role: "user", content: "ping" }]);
  });

  it("returns the provider's status and body on a 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 })));

    const result = await testAiConnection(anthropicCreds);

    expect(result).toEqual({ ok: false, status: 401, message: '{"error":{"message":"invalid x-api-key"}}' });
  });

  it("returns the status on a 404 (endpoint or deployment name)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Resource not found", { status: 404 })));

    const result = await testAiConnection(anthropicCreds);

    expect(result).toEqual({ ok: false, status: 404, message: "Resource not found" });
  });

  it("reports a network failure without a status, including the underlying cause", async () => {
    const networkError = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND llm.test") });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));

    const result = await testAiConnection(anthropicCreds);

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("status");
    expect(result).toEqual({ ok: false, message: "fetch failed (getaddrinfo ENOTFOUND llm.test)" });
  });

  it("reports missing configuration as a plain failure, not a thrown error", async () => {
    const result = await testAiConnection({ ...anthropicCreds, apiKey: null, provider: "openai-compatible", openAiCompatibleBaseUrl: null });

    expect(result).toEqual({ ok: false, message: "OpenAI-compatible requires an API key" });
  });
});

describe("testEmbeddingConnection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports ok when the vector length matches the stored column", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(embeddingVectors(1536)));

    const result = await testEmbeddingConnection(embeddingCreds, 1536);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe("text-embedding-3-small");
    expect(result.dimensions).toBe(1536);
  });

  it("fails with a clear message when the model returns a different dimension", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(embeddingVectors(768)));

    const result = await testEmbeddingConnection(embeddingCreds, 1536);

    expect(result).toEqual({
      ok: false,
      message: "model returned 768-dimensional vectors; Kompast stores 1536 — use a 1536-dimension model such as text-embedding-3-small, or a text-embedding-3 model (e.g. text-embedding-3-large) whose model/deployment name contains \"text-embedding-3\" so Kompast can request 1536 dimensions",
    });
  });

  it("returns the status and body on a 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Incorrect API key provided", { status: 401 })));

    const result = await testEmbeddingConnection(embeddingCreds, 1536);

    expect(result).toEqual({ ok: false, status: 401, message: "Incorrect API key provided" });
  });

  it("reports a network failure without a status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const result = await testEmbeddingConnection(embeddingCreds, 1536);

    expect(result).toEqual({ ok: false, message: "fetch failed" });
  });
});

describe("drivers throw AiProviderError", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the Anthropic driver keeps the old message text and attaches status, provider and body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("  model not found  ", { status: 404 })));

    const error = await createAnthropicDriver("k", null)
      .streamCompletion({ messages: [{ role: "user", content: "hi" }] }, () => {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toBeInstanceOf(Error);
    const providerError = error as AiProviderError;
    expect(providerError.message).toBe("Anthropic API error (404):   model not found  ");
    expect(providerError.status).toBe(404);
    expect(providerError.provider).toBe("Anthropic");
    expect(providerError.body).toBe("model not found");
  });

  it("caps the body at 500 characters", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x".repeat(2000), { status: 500 })));

    const error = await createOpenAiEmbeddingsDriver({ url: "https://example.test", headers: {} })
      .embed(["a"])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).body).toHaveLength(500);
    expect((error as AiProviderError).provider).toBe("Embedding provider");
  });
});
