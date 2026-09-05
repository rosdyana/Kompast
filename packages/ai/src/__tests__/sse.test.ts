import { describe, expect, it } from "vitest";
import { parseSse } from "../sse";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]!));
      i++;
    },
  });
}

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("parseSse", () => {
  it("parses complete data: frames into JSON", async () => {
    const stream = streamFromChunks(['data: {"a":1}\n\n', 'data: {"a":2}\n\n']);
    expect(await collect(parseSse(stream))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("reassembles a frame split across two chunk reads", async () => {
    const stream = streamFromChunks(['data: {"a":', '1}\n\n']);
    expect(await collect(parseSse(stream))).toEqual([{ a: 1 }]);
  });

  it("stops at a [DONE] sentinel without yielding it", async () => {
    const stream = streamFromChunks(['data: {"a":1}\n\n', "data: [DONE]\n\n", 'data: {"a":2}\n\n']);
    expect(await collect(parseSse(stream))).toEqual([{ a: 1 }]);
  });

  it("skips malformed JSON lines instead of throwing", async () => {
    const stream = streamFromChunks(["data: not-json\n\n", 'data: {"a":1}\n\n']);
    expect(await collect(parseSse(stream))).toEqual([{ a: 1 }]);
  });

  it("ignores non-data lines (e.g. event: names)", async () => {
    const stream = streamFromChunks(['event: ping\ndata: {"a":1}\n\n']);
    expect(await collect(parseSse(stream))).toEqual([{ a: 1 }]);
  });
});
