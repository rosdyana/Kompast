import "@blocknote/core/style.css";
import "@blocknote/shadcn/style.css";
import { useEffect, useMemo } from "react";
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, type Block, type PartialBlock } from "@blocknote/core";
import { en } from "@blocknote/core/locales";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { useTheme } from "@kompast/ui/theme";

const schema = BlockNoteSchema.create({
  blockSpecs: defaultBlockSpecs,
  inlineContentSpecs: defaultInlineContentSpecs,
});

export interface LiteEditorProps {
  initialContent?: PartialBlock[];
  onChange: (blocks: Block[]) => void;
  autoFocus?: boolean;
  className?: string;
  /** Shown as ghost text while the document is a single empty paragraph. */
  placeholder?: string;
}

/**
 * A plain, non-collaborative BlockNote editor — no Yjs, no Hocuspocus,
 * unlike apps/web/src/components/docs/Editor.tsx's DocEditor. Used for
 * issue descriptions and comment/reply bodies, where a single field
 * doesn't need live multi-user collaboration.
 *
 * `placeholder` goes through the supported `dictionary` route (the
 * top-level `placeholders` option is `@deprecated, provide placeholders
 * via dictionary instead` in the installed `@blocknote/core` v0.54.0
 * source) rather than that deprecated prop — merged onto BlockNote's own
 * `en` dictionary so slash-menu labels etc. stay at their defaults, only
 * `placeholders.default`/`emptyDocument` are overridden.
 */
export function LiteEditor({ initialContent, onChange, autoFocus, className, placeholder }: LiteEditorProps) {
  const { theme } = useTheme();
  const dictionary = useMemo(
    () => (placeholder ? { ...en, placeholders: { ...en.placeholders, default: placeholder, emptyDocument: placeholder } } : en),
    [placeholder],
  );
  const editor = useCreateBlockNote({
    schema,
    initialContent: initialContent && initialContent.length > 0 ? initialContent : undefined,
    dictionary,
  });

  useEffect(() => {
    const unsubscribe = editor.onChange((ed) => onChange(ed.document));
    return unsubscribe;
  }, [editor, onChange]);

  return (
    <BlockNoteView
      editor={editor}
      editable
      theme={theme}
      autoFocus={autoFocus}
      className={className ? `kp-lite-editor ${className}` : "kp-lite-editor"}
    />
  );
}
