export type AiStreamRequestBody =
  | { feature: "doc"; action: "continue" | "improve" | "shorten" | "expand" | "summarize" | "translate"; text: string; targetLanguage?: string }
  | { feature: "issue-description"; title: string; context?: string }
  | { feature: "sprint-summary"; sprintId: string };

/**
 * Browser-side counterpart to apps/web/src/routes/api/ai.stream.tsx's SSE
 * frames ({delta}/{done}/{error}) — deliberately not shared code with
 * packages/ai/src/sse.ts (that one parses each *provider's* raw SSE
 * shape server-side; this parses our own route's small frame contract,
 * and pulling packages/ai's provider-calling code into the browser
 * bundle would be its own mistake regardless of shape overlap).
 */
export async function streamAiCompletion(body: AiStreamRequestBody, onDelta: (delta: string) => void): Promise<void> {
  const res = await fetch("/api/ai/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `AI request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      let frame: { delta?: string; done?: boolean; error?: string };
      try {
        frame = JSON.parse(trimmed.slice(5).trim());
      } catch {
        continue;
      }
      if (frame.error) throw new Error(frame.error);
      if (frame.delta) onDelta(frame.delta);
      if (frame.done) return;
    }
  }
}
