import "@blocknote/core/style.css";
import "@blocknote/shadcn/style.css";
import { useEffect, useMemo } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { useCreateBlockNote, SuggestionMenuController, getDefaultReactSlashMenuItems } from "@blocknote/react";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/shadcn";
import { VersionHistory } from "./VersionHistory";
import { kompastViewBlockSpec } from "./KompastViewBlock";

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
              ],
              query,
            )
          }
        />
      </BlockNoteView>
    </div>
  );
}
