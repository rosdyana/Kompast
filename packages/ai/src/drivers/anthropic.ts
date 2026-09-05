import type { AiDriver } from "../types";
import { parseSse } from "../sse";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
const ANTHROPIC_VERSION = "2023-06-01";

export function createAnthropicDriver(apiKey: string, model: string | null): AiDriver {
  return {
    async streamCompletion(input, onDelta) {
      const system = input.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const turns = input.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: model ?? DEFAULT_ANTHROPIC_MODEL,
          max_tokens: input.maxTokens ?? 2048,
          system: system || undefined,
          messages: turns,
          stream: true,
        }),
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Anthropic API error (${res.status}): ${detail}`);
      }

      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const event of parseSse(res.body)) {
        if (event.type === "message_start") {
          inputTokens = event.message?.usage?.input_tokens ?? 0;
          outputTokens = event.message?.usage?.output_tokens ?? 0;
        } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          text += event.delta.text;
          onDelta(event.delta.text);
        } else if (event.type === "message_delta") {
          outputTokens = event.usage?.output_tokens ?? outputTokens;
        }
      }

      return { text, inputTokens, outputTokens };
    },
  };
}
