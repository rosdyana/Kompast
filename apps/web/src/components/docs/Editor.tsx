import "@blocknote/core/style.css";
import "@blocknote/shadcn/style.css";
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { useCreateBlockNote, SuggestionMenuController, getDefaultReactSlashMenuItems } from "@blocknote/react";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/shadcn";
import { useTranslation } from "@kompast/i18n";
import { useTheme } from "@kompast/ui/theme";
import { VersionHistory } from "./VersionHistory";
import { PageIcon } from "./DocsTree";
import { kompastViewBlockSpec } from "./KompastViewBlock";
import { mentionInlineSpec } from "./MentionInlineContent";
import { issueMentionInlineSpec } from "@/components/shared/IssueMentionInlineContent";
import { listPageTreeFn, linkPageMentionFn, createIssueFromDocLineFn } from "@/lib/server-fns/pages";
import { streamAiCompletion } from "@/lib/ai-stream-client";

type DocAiMode = "continue" | "improve" | "shorten" | "expand" | "summarize" | "translate";
type TFunction = ReturnType<typeof useTranslation>["t"];

/**
 * Always inserts the AI's result as new block(s) right after the current
 * one — never an in-place rewrite of the user's original text, even for
 * "improve"/"shorten"/"expand". A deliberate simplification: it means
 * every action shares one code path (insert-after, then replace the
 * placeholder), instead of a second in-place-replace path this couldn't
 * be interactively browser-verified against in this environment (see
 * README's P7 section — no Entra ID login available here).
 */
async function runDocAiAction(editor: ReturnType<typeof useCreateBlockNote>, t: TFunction, mode: DocAiMode, targetLanguage?: string) {
  const currentBlock = editor.getTextCursorPosition().block;

  const sourceBlocks = mode === "continue" ? editor.document.slice(0, editor.document.findIndex((b: { id: string }) => b.id === currentBlock.id) + 1) : [currentBlock];
  const sourceText = editor.blocksToMarkdownLossy(sourceBlocks.length ? sourceBlocks : [currentBlock]);
  if (!sourceText.trim()) return;

  const [placeholder] = editor.insertBlocks([{ type: "paragraph", content: t("editor.aiWritingPlaceholder") }], currentBlock, "after");
  if (!placeholder) return;

  let accumulated = "";
  try {
    await streamAiCompletion({ feature: "doc", action: mode, text: sourceText, targetLanguage }, (delta) => {
      accumulated += delta;
    });
  } catch (err) {
    editor.updateBlock(placeholder.id, { content: t("editor.aiFailedPrefix", { message: err instanceof Error ? err.message : t("editor.unknownError") }) });
    return;
  }

  const resultBlocks = editor.tryParseMarkdownToBlocks(accumulated);
  editor.replaceBlocks([placeholder.id], resultBlocks.length ? resultBlocks : [{ type: "paragraph", content: accumulated }]);
}

function aiSlashItems(t: TFunction): { title: string; mode: DocAiMode; targetLanguage?: string; aliases: string[] }[] {
  return [
    { title: t("editor.aiContinue"), mode: "continue", aliases: ["ai", "continue", "lanjutkan"] },
    { title: t("editor.aiImprove"), mode: "improve", aliases: ["ai", "improve", "perbaiki"] },
    { title: t("editor.aiShorten"), mode: "shorten", aliases: ["ai", "shorten", "perpendek"] },
    { title: t("editor.aiExpand"), mode: "expand", aliases: ["ai", "expand", "perpanjang"] },
    { title: t("editor.aiSummarize"), mode: "summarize", aliases: ["ai", "summarize", "ringkas"] },
    { title: t("editor.aiTranslateToEnglish"), mode: "translate", targetLanguage: "English", aliases: ["ai", "translate", "terjemah", "inggris"] },
    { title: t("editor.aiTranslateToIndonesian"), mode: "translate", targetLanguage: "Indonesian", aliases: ["ai", "translate", "terjemah", "indonesia"] },
  ];
}

// Collaborator cursor colors: distinct from each other but muted to sit with
// the low-chroma palette (eye-comfort rule), not neon.
const CURSOR_COLORS = ["#d27a6e", "#cf9551", "#bba55a", "#6ea878", "#56a39b", "#6b93d4", "#9280cf", "#c77ba6"];

function colorForUser(userId: string) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length]!;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see KompastViewBlock.tsx: TS's structural check on
// mixed-shape BlockSpecs records rejects this merge even though it's exactly BlockNote's own documented pattern.
const schema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, kompastView: kompastViewBlockSpec() as any },
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention: mentionInlineSpec as any, issueMention: issueMentionInlineSpec as any },
});

/** The slice of the BlockNote editor the doc page drives directly. */
export interface DocEditorHandle {
  document: unknown[];
  replaceBlocks(blocksToRemove: unknown[], blocksToInsert: unknown[]): void;
  focus(): void;
  setTextCursorPosition?(block: unknown, placement?: "start" | "end"): void;
}

function blockPlainText(block: { content?: unknown }): string {
  const content = Array.isArray(block.content) ? block.content : [];
  return content.map((c: any) => (c.type === "text" ? c.text : "")).join("").trim();
}

type DocEditorProps = {
  pageId: string;
  collabToken: string;
  collabWsUrl: string;
  canEdit: boolean;
  userId: string;
  userName: string;
  /** Render the inline "History" button above the editor (embedded uses). The full doc page puts history in its ⋯ menu instead. */
  historyButton?: boolean;
  /** Hands the live editor to the page (title Enter → focus, version restore from the ⋯ menu). */
  onEditorReady?: (editor: DocEditorHandle) => void;
};

/**
 * Owns the Hocuspocus connection's lifecycle in an effect (create on
 * mount/page change, destroy in cleanup) and only then mounts the editor.
 * It used to live in a useMemo destroyed by an effect cleanup: any effect
 * re-run (dev StrictMode double-invoke, HMR) destroyed the provider while
 * the memo kept handing back the dead instance, so edits silently never
 * reached apps/collab. It was also keyed on the collab token, which is
 * re-signed on every loader run — every router.invalidate() (a comment, a
 * favorite, a title save) tore down and reconnected the Yjs session,
 * dropping the caret and undo history. Now the provider lives for the
 * page and the freshest token is assigned onto its configuration, used on
 * the next (re)authentication. It must stay a plain string: the
 * function-form `token` option did not authenticate against apps/collab
 * (verified: edits were never stored).
 */
export function DocEditor(props: DocEditorProps) {
  const { pageId, collabToken, collabWsUrl } = props;
  const tokenRef = useRef(collabToken);
  tokenRef.current = collabToken;
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);

  useEffect(() => {
    const p = new HocuspocusProvider({ url: collabWsUrl, name: pageId, document: new Y.Doc(), token: tokenRef.current });
    setProvider(p);
    return () => {
      setProvider(null);
      p.destroy();
    };
  }, [pageId, collabWsUrl]);

  useEffect(() => {
    // Assign, don't call setConfiguration(): without a websocketProvider
    // argument that method builds a second, misconfigured socket.
    if (provider) provider.configuration.token = collabToken;
  }, [provider, collabToken]);

  if (!provider) return <div className="kp-doc min-h-[40vh]" />;
  return <CollabEditor key={`${pageId}`} provider={provider} {...props} />;
}

function CollabEditor({
  provider,
  pageId,
  canEdit,
  userId,
  userName,
  historyButton = true,
  onEditorReady,
}: DocEditorProps & { provider: HocuspocusProvider }) {
  const { t } = useTranslation("docs");
  const { theme } = useTheme();

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

  useEffect(() => {
    onEditorReady?.(editor as unknown as DocEditorHandle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  return (
    <div className="kp-doc">
      {canEdit && historyButton && (
        <div className="mb-2 flex justify-end">
          <VersionHistory pageId={pageId} editor={editor} />
        </div>
      )}
      <BlockNoteView editor={editor} editable={canEdit} theme={theme} slashMenu={false} className="min-h-[40vh] pb-8 pt-1">
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              [
                ...getDefaultReactSlashMenuItems(editor),
                {
                  title: t("editor.kanbanTableSlashItem"),
                  onItemClick: () => {
                    const currentBlock = editor.getTextCursorPosition().block;
                    editor.insertBlocks([{ type: "kompastView" }], currentBlock, "after");
                  },
                  aliases: ["kanban", "board", "tabel", "table", "view"],
                  group: "Kompast",
                },
                {
                  title: t("editor.createIssueSlashItem"),
                  onItemClick: async () => {
                    const currentBlock = editor.getTextCursorPosition().block;
                    const title = blockPlainText(currentBlock);
                    if (!title) return;
                    const originalContent = currentBlock.content;
                    editor.updateBlock(currentBlock.id, { content: t("editor.creatingIssueEllipsis") } as any);
                    try {
                      const created = await createIssueFromDocLineFn({ data: { pageId, title } });
                      editor.updateBlock(currentBlock.id, {
                        content: [{ type: "issueMention", props: { issueId: created.issueId, projectKey: created.projectKey, keySeq: created.keySeq, teamId: created.teamId ?? "", title } }],
                      } as any);
                    } catch (err) {
                      editor.updateBlock(currentBlock.id, { content: originalContent } as any);
                      editor.insertBlocks(
                        [{ type: "paragraph", content: t("editor.createIssueFailedPrefix", { message: err instanceof Error ? err.message : t("editor.unknownError") }) }] as any,
                        currentBlock,
                        "after",
                      );
                    }
                  },
                  aliases: ["issue", "task", "tugas", "buatissue"],
                  group: "Kompast",
                },
                ...aiSlashItems(t).map((item) => ({
                  title: item.title,
                  onItemClick: () => runDocAiAction(editor, t, item.mode, item.targetLanguage),
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
              .filter((p) => p.id !== pageId && (p.title || t("untitled")).toLowerCase().includes(lower))
              .slice(0, 8)
              .map((p) => ({
                title: p.title || t("untitled"),
                subtext: undefined,
                icon: <PageIcon icon={p.icon} size={16} />,
                onItemClick: () => {
                  editor.insertInlineContent([
                    { type: "mention", props: { pageId: p.id, title: p.title || t("untitled"), icon: p.icon ?? "" } },
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
