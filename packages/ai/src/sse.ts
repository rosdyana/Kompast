/**
 * Minimal Server-Sent-Events line parser shared by every driver here — all
 * three providers (Anthropic, Azure OpenAI, OpenAI-compatible) stream
 * `data: <json>\n\n` frames terminated by a `data: [DONE]` sentinel (Azure
 * and OpenAI-compatible) or simply the stream ending (Anthropic). Yields
 * the parsed JSON payload of each frame; malformed/partial lines are
 * skipped rather than thrown, since a line can legitimately be split
 * across two chunk reads.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        yield JSON.parse(data);
      } catch {
        continue;
      }
    }
  }
}
