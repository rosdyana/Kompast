import { describe, expect, it } from "vitest";
import { createAiClient, createEmbeddingClient, resolveModelName } from "../index";
import type { AiCredentials, EmbeddingCredentials } from "../types";

const base: AiCredentials = { provider: "anthropic", apiKey: null, model: null, azureEndpoint: null, azureDeployment: null, openAiCompatibleBaseUrl: null };
const embeddingBase: EmbeddingCredentials = { provider: "azure-openai", apiKey: null, model: null, azureEndpoint: null, azureDeployment: null, openAiCompatibleBaseUrl: null };

describe("createAiClient", () => {
  it("throws for anthropic with no API key configured", () => {
    expect(() => createAiClient({ ...base, provider: "anthropic" })).toThrow(/api key/i);
  });

  it("throws for azure-openai missing endpoint/deployment", () => {
    expect(() => createAiClient({ ...base, provider: "azure-openai", apiKey: "k" })).toThrow(/endpoint/i);
  });

  it("throws for openai-compatible missing a base URL", () => {
    expect(() => createAiClient({ ...base, provider: "openai-compatible", apiKey: "k" })).toThrow(/base url/i);
  });

  it("throws for openai-compatible missing a model name", () => {
    expect(() => createAiClient({ ...base, provider: "openai-compatible", apiKey: "k", openAiCompatibleBaseUrl: "https://x" })).toThrow(/model/i);
  });

  it("succeeds building an anthropic client given an API key (no network call made)", () => {
    expect(() => createAiClient({ ...base, provider: "anthropic", apiKey: "k" })).not.toThrow();
  });

  it("succeeds building an azure-openai client given full config", () => {
    expect(() => createAiClient({ ...base, provider: "azure-openai", apiKey: "k", azureEndpoint: "https://x.openai.azure.com", azureDeployment: "dep" })).not.toThrow();
  });

  it("succeeds building an openai-compatible client given full config", () => {
    expect(() => createAiClient({ ...base, provider: "openai-compatible", apiKey: "k", openAiCompatibleBaseUrl: "https://x", model: "m" })).not.toThrow();
  });
});

describe("resolveModelName", () => {
  it("uses the azure deployment name for azure-openai", () => {
    expect(resolveModelName({ ...base, provider: "azure-openai", azureDeployment: "gpt4o-deploy" })).toBe("gpt4o-deploy");
  });

  it("falls back to the default anthropic model when unset", () => {
    expect(resolveModelName({ ...base, provider: "anthropic", model: null })).toBe("claude-sonnet-5");
  });

  it("uses an explicit anthropic model override", () => {
    expect(resolveModelName({ ...base, provider: "anthropic", model: "claude-opus-5" })).toBe("claude-opus-5");
  });

  it("uses the configured model for openai-compatible", () => {
    expect(resolveModelName({ ...base, provider: "openai-compatible", model: "local-llama" })).toBe("local-llama");
  });
});

describe("createEmbeddingClient", () => {
  it("throws for azure-openai missing endpoint/deployment", () => {
    expect(() => createEmbeddingClient({ ...embeddingBase, apiKey: "k" })).toThrow(/endpoint/i);
  });

  it("throws for openai-compatible missing a base URL", () => {
    expect(() => createEmbeddingClient({ ...embeddingBase, provider: "openai-compatible", apiKey: "k" })).toThrow(/base url/i);
  });

  it("throws for openai-compatible missing a model name", () => {
    expect(() => createEmbeddingClient({ ...embeddingBase, provider: "openai-compatible", apiKey: "k", openAiCompatibleBaseUrl: "https://x" })).toThrow(/model/i);
  });

  it("succeeds building an azure-openai embedding client given full config", () => {
    expect(() => createEmbeddingClient({ ...embeddingBase, apiKey: "k", azureEndpoint: "https://x.openai.azure.com", azureDeployment: "embed-dep" })).not.toThrow();
  });

  it("succeeds building an openai-compatible embedding client given full config", () => {
    expect(() => createEmbeddingClient({ ...embeddingBase, provider: "openai-compatible", apiKey: "k", openAiCompatibleBaseUrl: "https://x", model: "m" })).not.toThrow();
  });
});
