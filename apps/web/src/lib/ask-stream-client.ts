export interface AskCitation {
  entityType: "issue" | "comment" | "page";
  entityId: string;
  excerpt: string;
  /** Absent on citations stored before live enrichment existed — the chip falls back to excerpt and renders unlinked. */
  title?: string;
  ref?: { kind: "issue"; teamId: string | null; projectKey: string; keySeq: number } | { kind: "page"; pageId: string };
}

export interface AskKompastResult {
  threadId: string;
  citations: AskCitation[];
}

/**
 * Same frame contract/parsing shape as ai-stream-client.ts's streamAiCompletion, extended with the threadId/citations the final frame carries here.
 * `{ tool }` frames (a lookup is running) go to onTool; any other unknown frame is ignored.
 */
export async function streamAskKompast(
  body: { threadId?: string; question: string },
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
  onTool?: (name: string) => void,
): Promise<AskKompastResult> {
  const res = await fetch("/api/ask/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Ask Kompast request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error("Stream ended without a done frame");
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      let frame: { delta?: string; tool?: string; done?: boolean; threadId?: string; citations?: AskCitation[]; error?: string };
      try {
        frame = JSON.parse(trimmed.slice(5).trim());
      } catch {
        continue;
      }
      if (frame.error) throw new Error(frame.error);
      if (frame.tool) onTool?.(frame.tool);
      if (frame.delta) onDelta(frame.delta);
      if (frame.done) return { threadId: frame.threadId!, citations: frame.citations ?? [] };
    }
  }
}
