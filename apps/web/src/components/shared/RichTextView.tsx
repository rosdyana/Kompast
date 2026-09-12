import "@blocknote/core/style.css";
import "@blocknote/shadcn/style.css";
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, type PartialBlock } from "@blocknote/core";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { useTheme } from "@kompast/ui/theme";

const schema = BlockNoteSchema.create({
  blockSpecs: defaultBlockSpecs,
  inlineContentSpecs: defaultInlineContentSpecs,
});

export function normalizeToBlocks(json: unknown): PartialBlock[] | undefined {
  if (json == null) return undefined;
  if (Array.isArray(json)) return json.length > 0 ? (json as PartialBlock[]) : undefined;
  if (typeof json === "object" && "text" in json && typeof (json as { text?: unknown }).text === "string") {
    const text = (json as { text: string }).text;
    if (!text) return undefined;
    return [{ type: "paragraph", content: [{ type: "text", text, styles: {} }] }] as PartialBlock[];
  }
  return undefined;
}

/**
 * Read-only render for stored rich-text content. Handles both shapes it
 * might be in: a legacy `{text: string}` object (everything written
 * before this pass) or a real `Block[]` array (anything written by
 * `LiteEditor` going forward).
 *
 * Remounts the underlying BlockNote editor instance whenever `content`
 * changes, keyed on `JSON.stringify(content)` as a `useCreateBlockNote`
 * dependency — that hook's `initialContent` is only consumed once, at
 * editor-creation time (inside its internal `useMemo`), so without a
 * content-derived dependency the view would keep showing stale content
 * after e.g. a comment edit reloads page data with new content.
 */
export function RichTextView({ content, className }: { content: unknown; className?: string }) {
  const { theme } = useTheme();
  const blocks = normalizeToBlocks(content);
  const editor = useCreateBlockNote({ schema, initialContent: blocks }, [JSON.stringify(content)]);

  if (!blocks) return null;
  return (
    <BlockNoteView
      editor={editor}
      editable={false}
      theme={theme}
      className={className ? `kp-lite-editor ${className}` : "kp-lite-editor"}
    />
  );
}
