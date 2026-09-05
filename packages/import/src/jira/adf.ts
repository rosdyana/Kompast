/**
 * Best-effort plain-text extraction from an Atlassian Document Format
 * node (JIRA Cloud's rich-text JSON for description/comment bodies) —
 * not a full ADF-to-Markdown renderer. Walks the `content` tree, joins
 * `text` leaf nodes, and inserts a blank line between block-level nodes
 * (paragraph/heading/listItem/codeBlock) so multi-paragraph text doesn't
 * collapse into one run-on line. Formatting (bold, links, tables, panels)
 * is deliberately dropped rather than reconstructed — lossy, but never
 * throws on a shape it doesn't recognize, unlike a strict renderer would.
 */
export function adfToPlainText(body: unknown): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (typeof body !== "object") return "";

  const BLOCK_TYPES = new Set(["paragraph", "heading", "listItem", "codeBlock", "blockquote"]);

  function walk(node: unknown): string {
    if (node == null || typeof node !== "object") return "";
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === "text" && typeof n.text === "string") return n.text;

    const childText = Array.isArray(n.content) ? n.content.map(walk).join("") : "";
    return n.type && BLOCK_TYPES.has(n.type) ? `${childText}\n\n` : childText;
  }

  return walk(body).trim();
}
