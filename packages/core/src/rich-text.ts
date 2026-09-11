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

function blockPlainText(block: unknown): string {
  if (block == null || typeof block !== "object") return "";
  const b = block as { content?: unknown; children?: unknown };

  const ownText = Array.isArray(b.content)
    ? b.content
        .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: string }).text ?? "") : ""))
        .join("")
    : "";

  const childText = Array.isArray(b.children) ? b.children.map((c) => blockPlainText(c)).filter(Boolean).join("\n") : "";

  return [ownText, childText].filter(Boolean).join("\n");
}
