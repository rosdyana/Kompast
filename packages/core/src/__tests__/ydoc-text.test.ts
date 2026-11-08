import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { pageStateToPlainText } from "../ydoc-text";

/**
 * These docs are hand-built to the exact shape BlockNote produces (observed
 * via blocksToYDoc(blocks, "document-store")):
 *   blockGroup > blockContainer > <block> > XmlText
 *   blockGroup > blockContainer > table > tableRow > (tableHeader | tableCell) > tableParagraph > XmlText
 *   blockGroup > blockContainer > kompastView
 * No DB needed — pure Yjs in, text out.
 */

function appendBlock(parent: Y.XmlFragment | Y.XmlElement, nodeName: string): Y.XmlElement {
  const el = new Y.XmlElement(nodeName);
  parent.push([el]);
  return el;
}

function appendText(parent: Y.XmlElement, text: string): void {
  const t = new Y.XmlText();
  parent.push([t]);
  t.insert(0, text);
}

/** blockContainer > <leafName> > text. Returns the blockContainer. */
function leafBlock(group: Y.XmlFragment | Y.XmlElement, leafName: string, text: string): Y.XmlElement {
  const container = appendBlock(group, "blockContainer");
  const leaf = appendBlock(container, leafName);
  appendText(leaf, text);
  return container;
}

function tableRow(table: Y.XmlElement, cells: string[], cellName: "tableCell" | "tableHeader" = "tableCell"): void {
  const row = appendBlock(table, "tableRow");
  for (const text of cells) {
    const cell = appendBlock(row, cellName);
    const para = appendBlock(cell, "tableParagraph");
    appendText(para, text);
  }
}

function buildState(build: (frag: Y.XmlFragment) => void): Uint8Array {
  const doc = new Y.Doc();
  build(doc.getXmlFragment("document-store"));
  return Y.encodeStateAsUpdate(doc);
}

describe("pageStateToPlainText", () => {
  it("emits one line per block in document order, tables as rows with cells joined by ' | '", () => {
    const state = buildState((frag) => {
      const group = appendBlock(frag, "blockGroup");
      leafBlock(group, "heading", "Project Plan");
      leafBlock(group, "paragraph", "Ship the sprint goal by Friday.");
      leafBlock(group, "bulletListItem", "first bullet");

      const tableContainer = appendBlock(group, "blockContainer");
      const table = appendBlock(tableContainer, "table");
      tableRow(table, ["Name", "Age"], "tableHeader");
      tableRow(table, ["Ana", "30"]);
      tableRow(table, ["Budi", "25"]);

      leafBlock(group, "paragraph", "Last paragraph.");
    });

    expect(pageStateToPlainText(state)).toBe(
      ["Project Plan", "Ship the sprint goal by Friday.", "first bullet", "Name | Age", "Ana | 30", "Budi | 25", "Last paragraph."].join("\n"),
    );
  });

  it("skips kompastView embeds entirely, even when they carry text", () => {
    const state = buildState((frag) => {
      const group = appendBlock(frag, "blockGroup");
      leafBlock(group, "paragraph", "Visible text.");
      const embedContainer = appendBlock(group, "blockContainer");
      const embed = appendBlock(embedContainer, "kompastView");
      appendText(embed, "EMBED-ONLY-TEXT-SHOULD-NOT-APPEAR");
      leafBlock(group, "paragraph", "Also visible.");
    });

    const text = pageStateToPlainText(state);
    expect(text).toBe("Visible text.\nAlso visible.");
    expect(text).not.toContain("EMBED-ONLY-TEXT");
  });

  it("returns an empty string for an empty document", () => {
    expect(pageStateToPlainText(buildState(() => {}))).toBe("");
  });

  it("walks nested children (a blockGroup inside a blockContainer) and keeps the child after its parent", () => {
    const state = buildState((frag) => {
      const group = appendBlock(frag, "blockGroup");
      const parentContainer = appendBlock(group, "blockContainer");
      appendText(appendBlock(parentContainer, "bulletListItem"), "parent item");
      const nestedGroup = appendBlock(parentContainer, "blockGroup");
      leafBlock(nestedGroup, "bulletListItem", "child item");
    });

    expect(pageStateToPlainText(state)).toBe("parent item\nchild item");
  });

  it("drops blank and whitespace-only blocks", () => {
    const state = buildState((frag) => {
      const group = appendBlock(frag, "blockGroup");
      leafBlock(group, "paragraph", "Kept.");
      leafBlock(group, "paragraph", "   ");
      leafBlock(group, "paragraph", "");
      leafBlock(group, "paragraph", "Also kept.");
    });

    expect(pageStateToPlainText(state)).toBe("Kept.\nAlso kept.");
  });

  it("round-trips through the same encoded state a collab save produces", () => {
    const source = new Y.Doc();
    const frag = source.getXmlFragment("document-store");
    const group = appendBlock(frag, "blockGroup");
    leafBlock(group, "heading", "Stored heading");
    const stored = Y.encodeStateAsUpdate(source);

    expect(pageStateToPlainText(stored)).toBe("Stored heading");
  });
});
