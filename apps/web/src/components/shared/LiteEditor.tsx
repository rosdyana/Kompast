import "@blocknote/core/style.css";
import "@blocknote/shadcn/style.css";
import { useEffect, useMemo } from "react";
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, type Block, type PartialBlock } from "@blocknote/core";
import { en } from "@blocknote/core/locales";
import { useCreateBlockNote, SuggestionMenuController } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { useTheme } from "@kompast/ui/theme";
import { issueMentionInlineSpec } from "@/components/shared/IssueMentionInlineContent";
import { userMentionInlineSpec } from "@/components/shared/UserMentionInlineContent";
import { searchWorkspaceFn } from "@/lib/server-fns/search";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see docs/Editor.tsx's identical cast: TS's
// structural check on mixed-shape inline content spec records rejects this merge even though it's exactly
// BlockNote's own documented pattern.
const schema = BlockNoteSchema.create({
  blockSpecs: defaultBlockSpecs,
  inlineContentSpecs: { ...defaultInlineContentSpecs, issueMention: issueMentionInlineSpec as any, userMention: userMentionInlineSpec as any },
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
    // ed.document is typed against this file's own (issueMention/userMention-extended)
    // schema, which isn't structurally assignable to the generic default `Block[]` the
    // onChange prop is typed with — safe to bridge through `unknown` since every caller
    // only ever treats these as plain JSON to store/serialize, never by BlockNote type.
    const unsubscribe = editor.onChange((ed) => onChange(ed.document as unknown as Block[]));
    return unsubscribe;
  }, [editor, onChange]);

  return (
    // `className` carries visual chrome (border/background/padding/
    // min-height), not just layout, so it can't be forwarded straight into
    // BlockNoteView's own `className` prop: BlockNoteView copies that exact
    // string onto TWO elements — its real container and a separate,
    // normally-invisible "portal" div it mounts floating menus into
    // (`editor.portalElement.className = mergeCSSClasses(..., className ||
    // "")` in @blocknote/react's BlockNoteView.tsx) — so the portal div
    // rendered as a second, empty, bordered/padded box sitting right next
    // to the real editor. Wrapping it here instead keeps that chrome on
    // one element; BlockNoteView itself only ever gets the bare
    // "kp-lite-editor" marker class both copies already share harmlessly.
    <div className={className}>
      <BlockNoteView editor={editor} editable theme={theme} autoFocus={autoFocus} className="kp-lite-editor">
        <SuggestionMenuController
          triggerCharacter="@"
          getItems={async (query) => {
            if (query.trim().length < 2) return [];
            const { people, issues } = await searchWorkspaceFn({ data: query });
            return [
              ...people.map((p) => ({
                title: p.name,
                subtext: p.email,
                group: "People",
                onItemClick: () => editor.insertInlineContent([{ type: "userMention", props: { userId: p.id, name: p.name } }, " "] as any),
              })),
              ...issues.map((i) => ({
                title: `${i.projectKey}-${i.keySeq}`,
                subtext: i.title,
                group: "Issues",
                onItemClick: () =>
                  editor.insertInlineContent(
                    [{ type: "issueMention", props: { issueId: i.id, projectKey: i.projectKey, keySeq: String(i.keySeq), teamId: i.teamId ?? "", title: i.title } }, " "] as any,
                  ),
              })),
            ];
          }}
        />
      </BlockNoteView>
    </div>
  );
}
