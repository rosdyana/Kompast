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
    expect(result).toEqual({ text: "Hello", inputTokens: 8, outputTokens: 3, toolCalls: [], stopReason: "end" });
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

describe("createOpenAiChatDriver tool calling", () => {
  const tools = [{ name: "get_issue", description: "Get an issue", inputSchema: { type: "object", properties: { key: { type: "string" } } } }];
  const driver = () => createOpenAiChatDriver({ url: "https://example.test/chat/completions", headers: { authorization: "Bearer x" }, model: "gpt-test" });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("assembles a tool call whose arguments stream in pieces, and reports stopReason tool_use", async () => {
    const frames = [
      { choices: [{ delta: { content: "Looking. " } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_issue", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ke' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'y":"KMP-42"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 9 } },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(frames)));

    const deltas: string[] = [];
    const result = await driver().streamCompletion({ messages: [{ role: "user", content: "what is KMP-42?" }], tools }, (d) => deltas.push(d));

    expect(deltas).toEqual(["Looking. "]);
    expect(result).toEqual({
      text: "Looking. ",
      inputTokens: 20,
      outputTokens: 9,
      stopReason: "tool_use",
      toolCalls: [{ id: "call_1", name: "get_issue", input: { key: "KMP-42" } }],
    });
  });

  it("returns a non-throwing { _raw } input when the streamed arguments are not valid JSON", async () => {
    const frames = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "get_issue", arguments: '{"key": ' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(frames)));
    const result = await driver().streamCompletion({ messages: [{ role: "user", content: "x" }], tools }, () => {});
    expect(result.toolCalls).toEqual([{ id: "call_x", name: "get_issue", input: { _raw: '{"key": ' } }]);
  });

  it("sends tools as function definitions and translates tool-call history into tool_calls / tool messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await driver().streamCompletion(
      {
        messages: [
          { role: "user", content: "what is KMP-42?" },
          { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "get_issue", input: { key: "KMP-42" } }] },
          { role: "tool", toolCallId: "call_1", content: '{"key":"KMP-42"}' },
        ],
        tools,
      },
      () => {},
    );

    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sentBody.tools).toEqual([
      { type: "function", function: { name: "get_issue", description: "Get an issue", parameters: tools[0]!.inputSchema } },
    ]);
    expect(sentBody.messages).toEqual([
      { role: "user", content: "what is KMP-42?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_issue", arguments: '{"key":"KMP-42"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"key":"KMP-42"}' },
    ]);
  });

  it("retries once without tools when the endpoint rejects the tools parameter with a 400, flattening tool history to text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("tools are not supported by this model", { status: 400 }))
      .mockResolvedValueOnce(sseResponse([{ choices: [{ delta: { content: "Plain answer" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]));
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    const result = await driver().streamCompletion(
      {
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "list_issues", input: {} }] },
          { role: "tool", toolCallId: "call_1", content: "[]" },
        ],
        tools,
      },
      (d) => deltas.push(d),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
    const retryBody = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(firstBody.tools).toBeDefined();
    expect(retryBody).not.toHaveProperty("tools");
    expect(JSON.stringify(retryBody.messages)).not.toContain("tool_call_id");
    expect(retryBody.messages[1].content).toContain("list_issues");
    expect(retryBody.messages[2].role).toBe("user");

    expect(deltas).toEqual(["Plain answer"]);
    expect(result).toEqual({ text: "Plain answer", inputTokens: 0, outputTokens: 0, toolCalls: [], stopReason: "end" });
  });

  it("does not retry a non-tools failure such as 500", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(driver().streamCompletion({ messages: [{ role: "user", content: "x" }], tools }, () => {})).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
