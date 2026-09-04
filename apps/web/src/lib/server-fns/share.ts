import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import * as Y from "yjs";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { resolveShareLink, getSharedPageContent, shareLinkRequiresPassword } from "@kompast/core";

/**
 * Public, unauthenticated surface — no requireAuthContext, no
 * withAuthorizedTenant. Deliberately split from getSharedPageContentFn so
 * the browser can check "does this link exist / need a password" without
 * ever sending a password over a GET request.
 */
export const getSharedPageMetaFn = createServerFn({ method: "GET" })
  .validator((token: string) => token)
  .handler(async ({ data: token }) => {
    const resolved = await resolveShareLink(token);
    if (!resolved) return null;
    return {
      title: resolved.page.title,
      icon: resolved.page.icon,
      requiresPassword: shareLinkRequiresPassword(resolved.shareLink),
    };
  });

const unlockSchema = z.object({ token: z.string(), password: z.string().optional() });

export const getSharedPageContentFn = createServerFn({ method: "POST" })
  .validator(unlockSchema)
  .handler(async ({ data }) => {
    const content = await getSharedPageContent(data.token, data.password);
    if (!content) return { ok: false as const };

    let html = "<p><em>Halaman ini masih kosong.</em></p>";
    if (content.ydocState) {
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, content.ydocState);
      const editor = ServerBlockNoteEditor.create();
      const blocks = editor.yDocToBlocks(ydoc, "document-store");
      html = await editor.blocksToFullHTML(blocks);
    }

    return { ok: true as const, title: content.page.title, icon: content.page.icon, html };
  });
