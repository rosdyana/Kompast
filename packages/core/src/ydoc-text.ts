import * as Y from "yjs";

/**
 * Plain-text extraction from a page's stored Yjs state, for RAG indexing.
 *
 * Deliberately uses plain `yjs` only — no @blocknote/* and no jsdom. packages/core
 * and apps/worker must stay free of those (see docs/ENGINEERING-NOTES.md, "REST API
 * + MCP"), so this walks the BlockNote Yjs structure by node name instead of
 * going through BlockNote's own parser.
 *
 * Observed structure (BlockNote 0.4x, `blocksToYDoc(blocks, "document-store")`):
 *   blockGroup > blockContainer > <block type> > XmlText        (paragraph, heading, bulletListItem, ...)
 *   blockGroup > blockContainer > table > tableRow > (tableHeader | tableCell) > tableParagraph > XmlText
 *   blockGroup > blockContainer > kompastView                  (embed — skipped entirely)
 * A block's nested children are a blockGroup sibling of its content element inside the blockContainer.
 */

/** Wrappers that only carry structure — recurse into them, never emit a line for them. */
const STRUCTURAL = new Set(["blockGroup", "blockContainer", "table", "tableRow", "tableContent", "tableParagraph"]);

/** Table cells: their text joins the row's " | " line. tableHeader is what BlockNote uses for the header row. */
const TABLE_CELL = new Set(["tableCell", "tableHeader"]);

/** Live data embeds (a board's table view) — never indexed as page text. */
const SKIPPED = new Set(["kompastView"]);

/** All text inside a node, in document order. Only string inserts count — embeds are dropped. */
function textOf(node: Y.XmlElement | Y.XmlText | Y.XmlFragment): string {
  if (node instanceof Y.XmlText) {
    return node
      .toDelta()
      .map((op: { insert?: unknown }) => (typeof op.insert === "string" ? op.insert : ""))
      .join("");
  }
  if (node instanceof Y.XmlElement && SKIPPED.has(node.nodeName)) return "";
  return node
    .toArray()
    .map((child) => {
      if (child instanceof Y.XmlText || child instanceof Y.XmlElement) return textOf(child);
      return "";
    })
    .join("");
}

function collectLines(node: Y.XmlElement | Y.XmlFragment, lines: string[]): void {
  if (node instanceof Y.XmlElement) {
    if (SKIPPED.has(node.nodeName)) return;
    if (node.nodeName === "table") {
      for (const row of node.toArray()) {
        if (!(row instanceof Y.XmlElement)) continue;
        const cells = row
          .toArray()
          .filter((c): c is Y.XmlElement => c instanceof Y.XmlElement && TABLE_CELL.has(c.nodeName))
          .map((cell) => textOf(cell));
        lines.push(cells.join(" | "));
      }
      return;
    }
    if (STRUCTURAL.has(node.nodeName)) {
      for (const child of node.toArray()) if (child instanceof Y.XmlElement || child instanceof Y.XmlFragment) collectLines(child, lines);
      return;
    }
    // Any other element is a leaf block (paragraph, heading, list item, code block, ...).
    lines.push(textOf(node));
    return;
  }
  // Top-level fragment: its children are blockGroups (or stray leaf blocks in an unexpected doc).
  for (const child of node.toArray()) if (child instanceof Y.XmlElement) collectLines(child, lines);
}

/**
 * Plain text of a page's stored Yjs state: one line per block, tables as one
 * line per row (cells joined by " | "), kompastView embeds skipped, empty lines
 * dropped. Returns "" for an empty or unparseable state.
 */
export function pageStateToPlainText(state: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const lines: string[] = [];
  collectLines(doc.getXmlFragment("document-store"), lines);
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}
