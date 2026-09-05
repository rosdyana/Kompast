import "@blocknote/core/style.css";
import "@blocknote/shadcn/style.css";
import { useEffect, useMemo } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { useCreateBlockNote, SuggestionMenuController, getDefaultReactSlashMenuItems } from "@blocknote/react";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/shadcn";
import { VersionHistory } from "./VersionHistory";
import { kompastViewBlockSpec } from "./KompastViewBlock";
import { mentionInlineSpec } from "./MentionInlineContent";
import { listPageTreeFn, linkPageMentionFn } from "@/lib/server-fns/pages";
import { streamAiCompletion } from "@/lib/ai-stream-client";

type DocAiMode = "continue" | "improve" | "shorten" | "expand" | "summarize" | "translate";

/**
 * Always inserts the AI's result as new block(s) right after the current
 * one — never an in-place rewrite of the user's original text, even for
 * "improve"/"shorten"/"expand". A deliberate simplification: it means
 * every action shares one code path (insert-after, then replace the
 * placeholder), instead of a second in-place-replace path this couldn't
 * be interactively browser-verified against in this environment (see
 * README's P7 section — no Entra ID login available here).
 */
async function runDocAiAction(editor: ReturnType<typeof useCreateBlockNote>, mode: DocAiMode, targetLanguage?: string) {
  const currentBlock = editor.getTextCursorPosition().block;

  const sourceBlocks = mode === "continue" ? editor.document.slice(0, editor.document.findIndex((b: { id: string }) => b.id === currentBlock.id) + 1) : [currentBlock];
  const sourceText = editor.blocksToMarkdownLossy(sourceBlocks.length ? sourceBlocks : [currentBlock]);
  if (!sourceText.trim()) return;

  const [placeholder] = editor.insertBlocks([{ type: "paragraph", content: "AI sedang menulis…" }], currentBlock, "after");
  if (!placeholder) return;

  let accumulated = "";
  try {
    await streamAiCompletion({ feature: "doc", action: mode, text: sourceText, targetLanguage }, (delta) => {
      accumulated += delta;
    });
  } catch (err) {
    editor.updateBlock(placeholder.id, { content: `AI gagal: ${err instanceof Error ? err.message : "unknown error"}` });
    return;
  }

  const resultBlocks = editor.tryParseMarkdownToBlocks(accumulated);
  editor.replaceBlocks([placeholder.id], resultBlocks.length ? resultBlocks : [{ type: "paragraph", content: accumulated }]);
}

const AI_SLASH_ITEMS: { title: string; mode: DocAiMode; targetLanguage?: string; aliases: string[] }[] = [
  { title: "AI: Lanjutkan menulis", mode: "continue", aliases: ["ai", "continue", "lanjutkan"] },
  { title: "AI: Perbaiki tulisan", mode: "improve", aliases: ["ai", "improve", "perbaiki"] },
  { title: "AI: Perpendek", mode: "shorten", aliases: ["ai", "shorten", "perpendek"] },
  { title: "AI: Perpanjang", mode: "expand", aliases: ["ai", "expand", "perpanjang"] },
  { title: "AI: Ringkas", mode: "summarize", aliases: ["ai", "summarize", "ringkas"] },
  { title: "AI: Terjemahkan ke Inggris", mode: "translate", targetLanguage: "English", aliases: ["ai", "translate", "terjemah", "inggris"] },
  { title: "AI: Terjemahkan ke Indonesia", mode: "translate", targetLanguage: "Indonesian", aliases: ["ai", "translate", "terjemah", "indonesia"] },
];

const CURSOR_COLORS = ["#f97066", "#f79009", "#f5d90a", "#66c61c", "#15b8a6", "#2e90fa", "#875bf7", "#ee46bc"];

function colorForUser(userId: string) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length]!;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see KompastViewBlock.tsx: TS's structural check on
// mixed-shape BlockSpecs records rejects this merge even though it's exactly BlockNote's own documented pattern.
const schema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, kompastView: kompastViewBlockSpec() as any },
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention: mentionInlineSpec as any },
});

export function DocEditor({
  pageId,
  collabToken,
  collabWsUrl,
  canEdit,
  userId,
  userName,
}: {
  pageId: string;
  collabToken: string;
  collabWsUrl: string;
  canEdit: boolean;
  userId: string;
  userName: string;
}) {
  const provider = useMemo(
    () => new HocuspocusProvider({ url: collabWsUrl, name: pageId, document: new Y.Doc(), token: collabToken }),
    [pageId, collabToken, collabWsUrl],
  );

  useEffect(() => () => provider.destroy(), [provider]);

  const editor = useCreateBlockNote(
    withCollaboration({
      // Cast: see the note above `schema` — same dual-instance friction, this
      // time between BlockNoteSchema and the CustomBlockNoteSchema type
      // withCollaboration's own resolved @blocknote/core copy expects.
      schema: schema as any,
      collaboration: {
        provider: { awareness: provider.awareness ?? undefined },
        fragment: provider.document.getXmlFragment("document-store"),
        user: { id: userId, name: userName, color: colorForUser(userId) },
      },
    }),
    [provider],
  );

  return (
    <div>
      {canEdit && (
        <div className="mb-2 flex justify-end">
          <VersionHistory pageId={pageId} editor={editor} />
        </div>
      )}
      <BlockNoteView editor={editor} editable={canEdit} theme="light" slashMenu={false} className="min-h-[60vh] px-2 py-4">
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              [
                ...getDefaultReactSlashMenuItems(editor),
                {
                  title: "Tabel Kanban",
                  onItemClick: () => {
                    const currentBlock = editor.getTextCursorPosition().block;
                    editor.insertBlocks([{ type: "kompastView" }], currentBlock, "after");
                  },
                  aliases: ["kanban", "board", "tabel", "table", "view"],
                  group: "Kompast",
                },
                ...AI_SLASH_ITEMS.map((item) => ({
                  title: item.title,
                  onItemClick: () => runDocAiAction(editor, item.mode, item.targetLanguage),
                  aliases: item.aliases,
                  group: "AI",
                })),
              ],
              query,
            )
          }
        />
        <SuggestionMenuController
          triggerCharacter="@"
          getItems={async (query) => {
            const { pages } = await listPageTreeFn();
            const lower = query.toLowerCase();
            return pages
              .filter((p) => p.id !== pageId && (p.title || "Tanpa judul").toLowerCase().includes(lower))
              .slice(0, 8)
              .map((p) => ({
                title: p.title || "Tanpa judul",
                subtext: undefined,
                icon: <span>{p.icon || "▤"}</span>,
                onItemClick: () => {
                  editor.insertInlineContent([
                    { type: "mention", props: { pageId: p.id, title: p.title || "Tanpa judul", icon: p.icon ?? "" } },
                    " ",
                  ] as any);
                  linkPageMentionFn({ data: { fromPageId: pageId, toPageId: p.id } });
                },
              }));
          }}
        />
      </BlockNoteView>
    </div>
  );
}
