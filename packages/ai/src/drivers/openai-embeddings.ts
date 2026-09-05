import type { EmbeddingDriver } from "../types";

/**
 * Shared OpenAI-Embeddings-shaped implementation — Azure OpenAI and
 * generic OpenAI-compatible endpoints both speak `POST {url}` with
 * `{input: string[], model?}`, returning `{data: [{embedding, index}]}`.
 * Not streamed (unlike chat completions) — one request, one response.
 */
export function createOpenAiEmbeddingsDriver(opts: { url: string; headers: Record<string, string>; model?: string }): EmbeddingDriver {
  return {
    async embed(texts) {
      const res = await fetch(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...opts.headers },
        body: JSON.stringify({ ...(opts.model ? { model: opts.model } : {}), input: texts }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Embedding provider error (${res.status}): ${detail}`);
      }

      const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      // Defensive, not assumed — sort by the index the API itself reports rather than trusting response array order matches request order.
      return [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}
