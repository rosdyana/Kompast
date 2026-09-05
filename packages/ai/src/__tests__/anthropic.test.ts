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
    expect(result).toEqual({ text: "Hello", inputTokens: 12, outputTokens: 5 });

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
});
