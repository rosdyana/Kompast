import type { AiDriver, AiMessage, AiToolCall } from "../types";
import { parseSse } from "../sse";
import { parseToolInput } from "../tool-input";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
const ANTHROPIC_VERSION = "2023-06-01";

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicTurn {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/**
 * Translates the provider-neutral message list into Anthropic's Messages
 * shape. System messages are excluded here (the caller sends them as the
 * top-level `system` field). Consecutive `tool` results collapse into ONE
 * user turn, because Anthropic requires every tool_result for an assistant
 * turn to come back together in the following user message.
 */
function toAnthropicTurns(messages: AiMessage[]): AnthropicTurn[] {
  const turns: AnthropicTurn[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block: AnthropicContentBlock = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const prev = turns[turns.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content) && prev.content.every((b) => b.type === "tool_result")) {
        prev.content.push(block);
      } else {
        turns.push({ role: "user", content: [block] });
      }
    } else if ("toolCalls" in m) {
      const blocks: AnthropicContentBlock[] = [
        ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
        ...m.toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
      ];
      turns.push({ role: "assistant", content: blocks });
    } else {
      turns.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
    }
  }
  return turns;
}

export function createAnthropicDriver(apiKey: string, model: string | null): AiDriver {
  return {
    async streamCompletion(input, onDelta) {
      const system = input.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");

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
          messages: toAnthropicTurns(input.messages),
          ...(input.tools?.length
            ? { tools: input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) }
            : {}),
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
      let stopReason: "end" | "tool_use" = "end";
      // Keyed by content-block index: a tool_use block's id/name come on its start event, its JSON input streams in partial_json pieces after.
      const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

      for await (const event of parseSse(res.body)) {
        if (event.type === "message_start") {
          inputTokens = event.message?.usage?.input_tokens ?? 0;
          outputTokens = event.message?.usage?.output_tokens ?? 0;
        } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          toolBlocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: "" });
        } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          text += event.delta.text;
          onDelta(event.delta.text);
        } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
          const block = toolBlocks.get(event.index);
          if (block) block.json += event.delta.partial_json ?? "";
        } else if (event.type === "message_delta") {
          outputTokens = event.usage?.output_tokens ?? outputTokens;
          if (event.delta?.stop_reason === "tool_use") stopReason = "tool_use";
        }
      }

      const toolCalls: AiToolCall[] = [...toolBlocks.values()].map((b) => ({ id: b.id, name: b.name, input: parseToolInput(b.json) }));
      return { text, inputTokens, outputTokens, toolCalls, stopReason };
    },
  };
}
