import type { Json } from "@kompast/db";

/**
 * Shape-agnostic plain-text extraction for descriptionJson/bodyJson: every
 * row written before this pass is a legacy { text: string } shape; every
 * row written by the new rich text editor going forward is a real BlockNote
 * Block[] JSON array. Dependency-free on purpose — packages/core must stay
 * BlockNote/jsdom-free (see README's documented Nitro-bundling gotcha:
 * @blocknote/server-util pulls jsdom, which can't be bundled server-side).
 * This is a plain-text reader for RAG indexing and quote-reply excerpts —
 * it deliberately strips all formatting. The actual rich read view (which
 * preserves formatting) is a separate apps/web-side component, not this.
 */
export function toPlainText(json: Json | null | undefined): string {
  if (json == null) return "";

  if (Array.isArray(json)) {
    return json
      .map((block) => blockPlainText(block))
      .filter(Boolean)
      .join("\n");
  }

  if (typeof json === "object" && "text" in json && typeof (json as { text?: unknown }).text === "string") {
    return (json as { text: string }).text;
  }

  return "";
}

/** Text of an inline run. A link's text is its own content (links were dropped before, which lost every imported link's words). */
function inlinePlainText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (!c || typeof c !== "object") return "";
      const node = c as { type?: string; text?: unknown; content?: unknown };
      if (node.type === "text") return String(node.text ?? "");
      if (node.type === "link") return inlinePlainText(node.content);
      return "";
    })
    .join("");
}

/**
 * A table's text: one line per row, cells joined by " | ". A cell is either a bare
 * inline run or a { type: "tableCell", content } object (see BlockNote's TableContent).
 */
function tablePlainText(table: { rows?: unknown }): string {
  if (!Array.isArray(table.rows)) return "";
  return table.rows
    .map((row) => {
      const cells = (row as { cells?: unknown })?.cells;
      if (!Array.isArray(cells)) return "";
      return cells.map((cell) => inlinePlainText(Array.isArray(cell) ? cell : (cell as { content?: unknown } | null)?.content)).join(" | ");
    })
    .join("\n");
}

function blockPlainText(block: unknown): string {
  if (block == null || typeof block !== "object") return "";
  const b = block as { content?: unknown; children?: unknown };

  let ownText = "";
  if (Array.isArray(b.content)) ownText = inlinePlainText(b.content);
  else if (b.content && typeof b.content === "object" && (b.content as { type?: string }).type === "tableContent") ownText = tablePlainText(b.content as { rows?: unknown });

  const childText = Array.isArray(b.children) ? b.children.map((c) => blockPlainText(c)).filter(Boolean).join("\n") : "";

  return [ownText, childText].filter(Boolean).join("\n");
}

/**
 * Collects every distinct `userMention` inline content node's `userId` out
 * of a Block[] JSON tree (descriptionJson/bodyJson), walking `content` and
 * `children` the same way blockPlainText does. Legacy `{text: string}`
 * bodies never contain a mention node, so they simply yield none. Used to
 * decide who to notify on a new comment/description — dependency-free for
 * the same reason toPlainText is (see its own top comment).
 */
export function extractMentionedUserIds(json: Json | null | undefined): string[] {
  if (json == null || !Array.isArray(json)) return [];
  const found = new Set<string>();
  for (const block of json) collectMentionedUserIds(block, found);
  return [...found];
}

function collectInlineMentions(content: unknown, found: Set<string>): void {
  if (!Array.isArray(content)) return;
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const node = c as { type?: string; props?: { userId?: unknown }; content?: unknown };
    if (node.type === "userMention") {
      const userId = node.props?.userId;
      if (typeof userId === "string" && userId) found.add(userId);
    } else if (node.type === "link") {
      collectInlineMentions(node.content, found);
    }
  }
}

function collectMentionedUserIds(block: unknown, found: Set<string>): void {
  if (block == null || typeof block !== "object") return;
  const b = block as { content?: unknown; children?: unknown };

  if (Array.isArray(b.content)) collectInlineMentions(b.content, found);
  else if (b.content && typeof b.content === "object" && (b.content as { type?: string }).type === "tableContent") {
    // Mentions inside table cells (a cell is a bare inline run, or a { content } object).
    const rows = (b.content as { rows?: unknown }).rows;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const cells = (row as { cells?: unknown })?.cells;
        if (!Array.isArray(cells)) continue;
        for (const cell of cells) collectInlineMentions(Array.isArray(cell) ? cell : (cell as { content?: unknown } | null)?.content, found);
      }
    }
  }
  if (Array.isArray(b.children)) {
    for (const c of b.children) collectMentionedUserIds(c, found);
  }
}
