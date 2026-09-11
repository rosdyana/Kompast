import "@blocknote/core/style.css";
import "@blocknote/shadcn/style.css";
import { useEffect } from "react";
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, type Block, type PartialBlock } from "@blocknote/core";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";

const schema = BlockNoteSchema.create({
  blockSpecs: defaultBlockSpecs,
  inlineContentSpecs: defaultInlineContentSpecs,
});

export interface LiteEditorProps {
  initialContent?: PartialBlock[];
  onChange: (blocks: Block[]) => void;
  autoFocus?: boolean;
  className?: string;
}

/**
 * A plain, non-collaborative BlockNote editor — no Yjs, no Hocuspocus,
 * unlike apps/web/src/components/docs/Editor.tsx's DocEditor. Used for
 * issue descriptions and comment/reply bodies, where a single field
 * doesn't need live multi-user collaboration.
 *
 * Note: a `placeholder` prop was intentionally left out. The only
 * placeholder mechanism on `BlockNoteEditorOptions` is `placeholders`
 * (`Record<string, string | undefined>`), which is marked
 * `@deprecated, provide placeholders via dictionary instead` and
 * `@internal` in the installed `@blocknote/core` v0.54.0 source
 * (`editor/BlockNoteEditor.ts`) — not a stable surface worth wiring up
 * for a nice-to-have. The supported route (a custom `dictionary`) is
 * more involved than this component warrants.
 */
export function LiteEditor({ initialContent, onChange, autoFocus, className }: LiteEditorProps) {
  const editor = useCreateBlockNote({
    schema,
    initialContent: initialContent && initialContent.length > 0 ? initialContent : undefined,
  });

  useEffect(() => {
    const unsubscribe = editor.onChange((ed) => onChange(ed.document));
    return unsubscribe;
  }, [editor, onChange]);

  return <BlockNoteView editor={editor} editable theme="light" autoFocus={autoFocus} className={className} />;
}
