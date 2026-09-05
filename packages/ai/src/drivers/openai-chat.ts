import type { AiDriver } from "../types";
import { parseSse } from "../sse";

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
  return {
    async streamCompletion(input, onDelta) {
      const res = await fetch(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...opts.headers },
        body: JSON.stringify({
          ...(opts.model ? { model: opts.model } : {}),
          messages: input.messages,
          max_tokens: input.maxTokens ?? 2048,
          stream: true,
          stream_options: { include_usage: true },
        }),
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`AI provider error (${res.status}): ${detail}`);
      }

      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const chunk of parseSse(res.body)) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onDelta(delta);
        }
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        }
      }

      return { text, inputTokens, outputTokens };
    },
  };
}
