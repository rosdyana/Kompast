import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { createServerSchema, redactEmbedsForGuests } from "../blocknote-schema";

describe("kompastView block schema", () => {
  it("round-trips through a real Yjs encode/decode without losing its props", async () => {
    const editor = ServerBlockNoteEditor.create({ schema: createServerSchema() as any });
    const blocks = [
      { type: "paragraph", content: "Hello" },
      { type: "kompastView", props: { boardId: "board_123", viewId: "view_456", projectKey: "KPT" } },
    ];

    const ydoc = editor.blocksToYDoc(blocks as any, "document-store");
    const state = Y.encodeStateAsUpdate(ydoc);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, state);

    const decoded: any[] = editor.yDocToBlocks(restored, "document-store");
    const kompastBlock = decoded.find((b) => b.type === "kompastView");
    expect(kompastBlock?.props).toMatchObject({ boardId: "board_123", viewId: "view_456", projectKey: "KPT" });

    const paragraph = decoded.find((b) => b.type === "paragraph");
    expect(paragraph).toBeDefined();
  });

  it("blocksToFullHTML alone leaks raw prop values as data-* attributes (documents why redaction happens before export, not inside the block's own render)", async () => {
    const editor = ServerBlockNoteEditor.create({ schema: createServerSchema() as any });
    const blocks = [{ type: "kompastView", props: { boardId: "board_123", viewId: "view_456", projectKey: "KPT" } }];

    const ydoc = editor.blocksToYDoc(blocks as any, "document-store");
    const decoded = editor.yDocToBlocks(ydoc, "document-store");
    const html = await editor.blocksToFullHTML(decoded);

    expect(html).toContain("board_123");
  });

  it("redactEmbedsForGuests strips kompastView blocks before export, so no board data reaches the guest HTML", async () => {
    const editor = ServerBlockNoteEditor.create({ schema: createServerSchema() as any });
    const blocks = [{ type: "kompastView", props: { boardId: "board_123", viewId: "view_456", projectKey: "KPT" } }];

    const ydoc = editor.blocksToYDoc(blocks as any, "document-store");
    const decoded = editor.yDocToBlocks(ydoc, "document-store");
    const html = await editor.blocksToFullHTML(redactEmbedsForGuests(decoded) as any);

    expect(html).toContain("Tabel Kanban");
    expect(html).not.toContain("board_123");
    expect(html).not.toContain("view_456");
  });

  it("redactEmbedsForGuests also strips kompastView blocks nested inside a container block's children", async () => {
    const nested = [
      {
        type: "paragraph",
        content: [{ type: "text", text: "outer", styles: {} }],
        children: [{ type: "kompastView", props: { boardId: "board_999", viewId: "", projectKey: "" }, children: [] }],
      },
    ];
    const redacted = redactEmbedsForGuests(nested);
    expect(JSON.stringify(redacted)).not.toContain("board_999");
    expect(redacted[0].children[0].type).toBe("paragraph");
  });
});
