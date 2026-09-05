import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiEmbeddingsDriver } from "../drivers/openai-embeddings";
import { createAzureOpenAiEmbeddingsDriver } from "../drivers/azure-openai";
import { createOpenAiCompatibleEmbeddingsDriver } from "../drivers/openai-compatible";

function embeddingsResponse(vectors: number[][]): Response {
  return new Response(JSON.stringify({ data: vectors.map((embedding, index) => ({ embedding, index })) }), { status: 200 });
}

describe("createOpenAiEmbeddingsDriver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns one vector per input text, in request order", async () => {
    const fetchMock = vi.fn().mockResolvedValue(embeddingsResponse([[0.1, 0.2], [0.3, 0.4]]));
    vi.stubGlobal("fetch", fetchMock);

    const driver = createOpenAiEmbeddingsDriver({ url: "https://example.test/embeddings", headers: { authorization: "Bearer x" }, model: "text-embedding-3-small" });
    const result = await driver.embed(["hello", "world"]);

    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ model: "text-embedding-3-small", input: ["hello", "world"] });
  });

  it("re-sorts by the response's own index rather than trusting array order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ embedding: [9, 9], index: 1 }, { embedding: [1, 1], index: 0 }] }), { status: 200 })),
    );
    const driver = createOpenAiEmbeddingsDriver({ url: "https://example.test", headers: {} });
    expect(await driver.embed(["a", "b"])).toEqual([[1, 1], [9, 9]]);
  });

  it("throws with the response body on a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })));
    const driver = createOpenAiEmbeddingsDriver({ url: "https://example.test", headers: {} });
    await expect(driver.embed(["x"])).rejects.toThrow(/400/);
  });
});

describe("createAzureOpenAiEmbeddingsDriver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the deployment-scoped embeddings URL with the api-key header and no model field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(embeddingsResponse([[0.5]]));
    vi.stubGlobal("fetch", fetchMock);

    const driver = createAzureOpenAiEmbeddingsDriver("azure-key", "https://my-resource.openai.azure.com", "embed-deploy");
    await driver.embed(["hi"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://my-resource.openai.azure.com/openai/deployments/embed-deploy/embeddings?api-version=2024-08-01-preview");
    expect(init.headers["api-key"]).toBe("azure-key");
    expect(JSON.parse(init.body).model).toBeUndefined();
  });
});

describe("createOpenAiCompatibleEmbeddingsDriver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds {baseUrl}/embeddings with a Bearer token and the configured model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(embeddingsResponse([[0.2]]));
    vi.stubGlobal("fetch", fetchMock);

    const driver = createOpenAiCompatibleEmbeddingsDriver("compat-key", "https://llm.internal/v1/", "local-embed-model");
    await driver.embed(["hi"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://llm.internal/v1/embeddings");
    expect(init.headers.authorization).toBe("Bearer compat-key");
    expect(JSON.parse(init.body).model).toBe("local-embed-model");
  });
});
