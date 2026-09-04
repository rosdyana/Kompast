import "@blocknote/core/style.css";
import "@blocknote/shadcn/style.css";
import { useEffect, useMemo } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { useCreateBlockNote } from "@blocknote/react";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/shadcn";

const CURSOR_COLORS = ["#f97066", "#f79009", "#f5d90a", "#66c61c", "#15b8a6", "#2e90fa", "#875bf7", "#ee46bc"];

function colorForUser(userId: string) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length]!;
}

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
      collaboration: {
        provider: { awareness: provider.awareness ?? undefined },
        fragment: provider.document.getXmlFragment("document-store"),
        user: { id: userId, name: userName, color: colorForUser(userId) },
      },
    }),
    [provider],
  );

  return (
    <BlockNoteView editor={editor} editable={canEdit} theme="light" className="min-h-[60vh] px-2 py-4" />
  );
}
