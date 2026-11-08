import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicDriver } from "../drivers/anthropic";

function sseResponse(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe("createAnthropicDriver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams text deltas via onDelta and returns the full text + token usage", async () => {
    const frames = [
      { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
      { type: "message_delta", usage: { output_tokens: 5 } },
    ];
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(frames));
    vi.stubGlobal("fetch", fetchMock);

    const driver = createAnthropicDriver("test-key", null);
    const deltas: string[] = [];
    const result = await driver.streamCompletion({ messages: [{ role: "user", content: "hi" }] }, (d) => deltas.push(d));

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result).toEqual({ text: "Hello", inputTokens: 12, outputTokens: 5, toolCalls: [], stopReason: "end" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("test-key");
    const sentBody = JSON.parse(init.body);
    expect(sentBody.model).toBe("claude-sonnet-5");
    expect(sentBody.stream).toBe(true);
  });

  it("uses an explicit model override instead of the default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const driver = createAnthropicDriver("test-key", "claude-opus-5");
    await driver.streamCompletion({ messages: [{ role: "user", content: "hi" }] }, () => {});

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body).model).toBe("claude-opus-5");
  });

  it("puts system messages into the top-level system field, not the messages array", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const driver = createAnthropicDriver("test-key", null);
    await driver.streamCompletion(
      { messages: [{ role: "system", content: "be terse" }, { role: "user", content: "hi" }] },
      () => {},
    );

    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse(init.body);
    expect(sentBody.system).toBe("be terse");
    expect(sentBody.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("throws with the response body on a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })));
    const driver = createAnthropicDriver("test-key", null);
    await expect(driver.streamCompletion({ messages: [{ role: "user", content: "hi" }] }, () => {})).rejects.toThrow(/400/);
  });

  describe("tool calling", () => {
    const tools = [{ name: "list_issues", description: "List issues", inputSchema: { type: "object", properties: { assignee: { type: "string" } } } }];

    it("parses a tool_use block whose JSON input arrives split across chunks, and reports stopReason tool_use", async () => {
      const frames = [
        { type: "message_start", message: { usage: { input_tokens: 30, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "list_issues", input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"assig' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'nee": "me"}' } },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(frames)));

      const deltas: string[] = [];
      const result = await createAnthropicDriver("k", null).streamCompletion({ messages: [{ role: "user", content: "mine?" }], tools }, (d) => deltas.push(d));

      expect(deltas).toEqual(["Let me check."]);
      expect(result).toEqual({
        text: "Let me check.",
        inputTokens: 30,
        outputTokens: 7,
        stopReason: "tool_use",
        toolCalls: [{ id: "toolu_1", name: "list_issues", input: { assignee: "me" } }],
      });
    });

    it("reports stopReason end and no tool calls for a plain text answer", async () => {
      const frames = [
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(frames)));
      const result = await createAnthropicDriver("k", null).streamCompletion({ messages: [{ role: "user", content: "hi" }], tools }, () => {});
      expect(result.stopReason).toBe("end");
      expect(result.toolCalls).toEqual([]);
    });

    it("sends tools in Anthropic's input_schema shape", async () => {
      const fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
      vi.stubGlobal("fetch", fetchMock);
      await createAnthropicDriver("k", null).streamCompletion({ messages: [{ role: "user", content: "hi" }], tools }, () => {});

      const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(sentBody.tools).toEqual([{ name: "list_issues", description: "List issues", input_schema: tools[0]!.inputSchema }]);
    });

    it("omits the tools field entirely when no tools are given", async () => {
      const fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
      vi.stubGlobal("fetch", fetchMock);
      await createAnthropicDriver("k", null).streamCompletion({ messages: [{ role: "user", content: "hi" }] }, () => {});
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).not.toHaveProperty("tools");
    });

    it("translates an assistant tool-call turn and consecutive tool results into Anthropic content blocks", async () => {
      const fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
      vi.stubGlobal("fetch", fetchMock);

      await createAnthropicDriver("k", null).streamCompletion(
        {
          messages: [
            { role: "system", content: "be terse" },
            { role: "user", content: "mine?" },
            {
              role: "assistant",
              content: "Checking.",
              toolCalls: [
                { id: "toolu_a", name: "list_issues", input: { assignee: "me" } },
                { id: "toolu_b", name: "get_issue", input: { key: "KMP-1" } },
              ],
            },
            { role: "tool", toolCallId: "toolu_a", content: '{"issues":[]}' },
            { role: "tool", toolCallId: "toolu_b", content: '{"key":"KMP-1"}' },
          ],
          tools,
        },
        () => {},
      );

      const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(sentBody.system).toBe("be terse");
      expect(sentBody.messages).toEqual([
        { role: "user", content: "mine?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "toolu_a", name: "list_issues", input: { assignee: "me" } },
            { type: "tool_use", id: "toolu_b", name: "get_issue", input: { key: "KMP-1" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: '{"issues":[]}' },
            { type: "tool_result", tool_use_id: "toolu_b", content: '{"key":"KMP-1"}' },
          ],
        },
      ]);
    });
  });
});
