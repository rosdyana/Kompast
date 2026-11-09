import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { yDocToBlocks } from "@blocknote/core/yjs";
import { blocksToYDocState } from "../ydoc";
import { createServerSchema } from "../schema";

/** Decodes stored state the way apps/web does, with a separate headless editor, so the test checks the round trip rather than shared state. */
function decode(state: Uint8Array): any[] {
  const editor = BlockNoteEditor.create({ schema: createServerSchema() as any, _headless: true } as any) as any;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return yDocToBlocks(editor, doc, "document-store");
}

const text = (block: any): string => (block.content ?? []).map((c: any) => (c.type === "text" ? c.text : c.type === "mention" ? `@${c.props.title}` : "")).join("");

describe("blocksToYDocState (headless, no DOM)", () => {
  it("round-trips headings, mentions, checklists, tables and code blocks through stored Yjs state", () => {
    const blocks = [
      { type: "heading", props: { level: 2 }, content: "Sprint goals" },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "See ", styles: {} },
          { type: "mention", props: { pageId: "page_abc", title: "Roadmap", icon: "" } },
          { type: "text", text: " for context.", styles: {} },
        ],
      },
      { type: "checkListItem", props: { checked: true }, content: "Ship the importer" },
      {
        type: "table",
        content: {
          type: "tableContent",
          rows: [
            { cells: [[{ type: "text", text: "Name", styles: {} }], [{ type: "text", text: "Owner", styles: {} }]] },
            { cells: [[{ type: "text", text: "Importer", styles: {} }], [{ type: "text", text: "Ross", styles: {} }]] },
          ],
        },
      },
      { type: "codeBlock", props: { language: "typescript" }, content: "const x = 1;" },
    ];

    const state = blocksToYDocState(blocks);
    expect(state).toBeInstanceOf(Uint8Array);
    expect(state.byteLength).toBeGreaterThan(0);

    const decoded = decode(state);
    expect(decoded.map((b) => b.type)).toEqual(["heading", "paragraph", "checkListItem", "table", "codeBlock"]);

    const heading = decoded[0];
    expect(heading.props.level).toBe(2);
    expect(text(heading)).toBe("Sprint goals");

    const paragraph = decoded[1];
    expect(text(paragraph)).toBe("See @Roadmap for context.");
    const mention = paragraph.content.find((c: any) => c.type === "mention");
    expect(mention.props).toMatchObject({ pageId: "page_abc", title: "Roadmap" });

    expect(decoded[2].props.checked).toBe(true);
    expect(text(decoded[2])).toBe("Ship the importer");

    const table = decoded[3];
    expect(table.content.rows).toHaveLength(2);
    const cellText = (cell: any) => (Array.isArray(cell) ? cell : cell.content).map((c: any) => c.text).join("");
    expect(table.content.rows.map((r: any) => r.cells.map(cellText))).toEqual([
      ["Name", "Owner"],
      ["Importer", "Ross"],
    ]);

    expect(decoded[4].props.language).toBe("typescript");
    expect(text(decoded[4])).toBe("const x = 1;");
  });

  it("reuses one editor across calls (the second call produces an independent, equally valid state)", () => {
    const a = blocksToYDocState([{ type: "paragraph", content: "one" }]);
    const b = blocksToYDocState([{ type: "paragraph", content: "two" }]);
    expect(text(decode(a)[0])).toBe("one");
    expect(text(decode(b)[0])).toBe("two");
  });
});
