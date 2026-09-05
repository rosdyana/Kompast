import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiChatDriver } from "../drivers/openai-chat";
import { createAzureOpenAiDriver } from "../drivers/azure-openai";
import { createOpenAiCompatibleDriver } from "../drivers/openai-compatible";

function sseResponse(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe("createOpenAiChatDriver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams choices[0].delta.content via onDelta and reads final usage", async () => {
    const frames = [
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 3 } },
    ];
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(frames));
    vi.stubGlobal("fetch", fetchMock);

    const driver = createOpenAiChatDriver({ url: "https://example.test/chat/completions", headers: { authorization: "Bearer x" }, model: "gpt-test" });
    const deltas: string[] = [];
    const result = await driver.streamCompletion({ messages: [{ role: "user", content: "hi" }] }, (d) => deltas.push(d));

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result).toEqual({ text: "Hello", inputTokens: 8, outputTokens: 3 });
  });

  it("throws with the response body on a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    const driver = createOpenAiChatDriver({ url: "https://example.test", headers: {} });
    await expect(driver.streamCompletion({ messages: [{ role: "user", content: "hi" }] }, () => {})).rejects.toThrow(/500/);
  });
});

describe("createAzureOpenAiDriver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the deployment-scoped URL and uses the api-key header, with no model field in the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const driver = createAzureOpenAiDriver("azure-key", "https://my-resource.openai.azure.com", "gpt4o-deploy");
    await driver.streamCompletion({ messages: [{ role: "user", content: "hi" }] }, () => {});

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://my-resource.openai.azure.com/openai/deployments/gpt4o-deploy/chat/completions?api-version=2024-08-01-preview");
    expect(init.headers["api-key"]).toBe("azure-key");
    expect(JSON.parse(init.body).model).toBeUndefined();
  });
});

describe("createOpenAiCompatibleDriver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds {baseUrl}/chat/completions with a Bearer token and the configured model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const driver = createOpenAiCompatibleDriver("compat-key", "https://llm.internal/v1/", "local-llama");
    await driver.streamCompletion({ messages: [{ role: "user", content: "hi" }] }, () => {});

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://llm.internal/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer compat-key");
    expect(JSON.parse(init.body).model).toBe("local-llama");
  });
});
