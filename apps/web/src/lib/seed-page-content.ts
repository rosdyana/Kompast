import * as Y from "yjs";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { schema } from "@kompast/db";
import type { Tx } from "@kompast/core";
import { createServerSchema } from "./blocknote-schema";

/**
 * Writes a brand-new page's initial ydoc_state from Markdown, in the same
 * transaction as the page row's own insert. Safe ONLY because the page id
 * was just created a moment ago — no live collab connection can possibly
 * exist for it yet, so there's nothing to race with. This is NOT a pattern
 * for updating an existing page's content. Deliberately stays in apps/web,
 * not packages/core — see this plan's Global Constraints on jsdom/Nitro.
 */
export async function seedPageContentFromMarkdown(tx: Tx, pageId: string, markdown: string): Promise<void> {
  const editor = ServerBlockNoteEditor.create({ schema: createServerSchema() as any });
  const blocks = await editor.tryParseMarkdownToBlocks(markdown);
  const ydoc = editor.blocksToYDoc(blocks, "document-store");
  await tx.insert(schema.ydocState).values({ pageId, state: Buffer.from(Y.encodeStateAsUpdate(ydoc)) });
}
