import type { AiDriver, AiMessage, AiToolCall, CompletionRequest } from "../types";
import { parseSse } from "../sse";
import { parseToolInput } from "../tool-input";

/**
 * Statuses that, on a request carrying `tools`, most plausibly mean "this
 * endpoint doesn't support tool calling" rather than a real failure. Self-hosted
 * OpenAI-compatible servers (vLLM, Ollama, llama.cpp and similar) often reject
 * the `tools` parameter outright, so we retry once without it instead of failing
 * the whole answer.
 */
const TOOLS_UNSUPPORTED_STATUSES = new Set([400, 404, 422]);

function toChatMessages(messages: AiMessage[]) {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if ("toolCalls" in m) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Plain-text stand-in for tool history, used only on the no-tools retry: the
 * endpoint can't interpret `tool` or `tool_calls` messages, so the same facts
 * are restated as ordinary user/assistant text.
 */
function flattenToolMessages(messages: AiMessage[]): AiMessage[] {
  return messages.map((m): AiMessage => {
    if (m.role === "tool") return { role: "user", content: `Result of a workspace lookup:\n${m.content}` };
    if ("toolCalls" in m) {
      const calls = m.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join("\n");
      return { role: "assistant", content: [m.content, calls].filter(Boolean).join("\n") };
    }
    return m;
  });
}

/**
 * Shared OpenAI-Chat-Completions-shaped streaming implementation — both
 * Azure OpenAI and generic OpenAI-compatible endpoints speak this same
 * `POST {url}` + `data: {choices:[{delta:{content}}]}` SSE format, differing
 * only in URL shape and auth header (azure: `api-key`, compatible: Bearer).
 * `stream_options.include_usage` asks for a final usage-only chunk; a
 * self-hosted server that ignores it just leaves inputTokens/outputTokens
 * at 0 rather than us guessing — an unlabeled deployment isn't guaranteed
 * to implement OpenAI's newer streaming-usage extension.
 */
export function createOpenAiChatDriver(opts: { url: string; headers: Record<string, string>; model?: string }): AiDriver {
  function buildBody(req: CompletionRequest) {
    return {
      ...(opts.model ? { model: opts.model } : {}),
      messages: toChatMessages(req.messages),
      max_tokens: req.maxTokens ?? 2048,
      stream: true,
      stream_options: { include_usage: true },
      ...(req.tools?.length
        ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
        : {}),
    };
  }

  function send(req: CompletionRequest) {
    return fetch(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body: JSON.stringify(buildBody(req)),
    });
  }

  return {
    async streamCompletion(input, onDelta) {
      let res = await send(input);

      if (input.tools?.length && !res.ok && TOOLS_UNSUPPORTED_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => {});
        res = await send({ ...input, tools: undefined, messages: flattenToolMessages(input.messages) });
      }

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`AI provider error (${res.status}): ${detail}`);
      }

      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let finishReason: string | undefined;
      // Tool calls stream as fragments keyed by `index`: id and name arrive first, the JSON arguments in pieces after.
      const toolAcc = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of parseSse(res.body)) {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) {
          text += delta;
          onDelta(delta);
        }
        for (const tc of choice?.delta?.tool_calls ?? []) {
          const key = tc.index ?? 0;
          const slot = toolAcc.get(key) ?? { id: "", name: "", args: "" };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name && !slot.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          toolAcc.set(key, slot);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        }
      }

      const toolCalls: AiToolCall[] = [...toolAcc.entries()].map(([index, s]) => ({
        id: s.id || `call_${index}`,
        name: s.name,
        input: parseToolInput(s.args),
      }));
      // Some servers return tool calls with a different finish_reason, so either signal means the model stopped to request tools.
      const stopReason = finishReason === "tool_calls" || toolCalls.length > 0 ? "tool_use" : "end";
      return { text, inputTokens, outputTokens, toolCalls, stopReason };
    },
  };
}
