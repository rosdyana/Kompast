import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createHash } from "node:crypto";
import * as z from "zod";
import * as Y from "yjs";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { resolveShareLink, getSharedPageContent, shareLinkRequiresPassword } from "@kompast/core";
import { createServerSchema, redactEmbedsForGuests } from "../blocknote-schema";
import { clientIp, rateLimit } from "../rate-limit";

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
    if (data.password !== undefined) {
      // Only password guesses are capped; the first no-password load is free. Keyed on the link (a hash, so
      // the raw token isn't stored in Redis) and the IP, so one visitor can't brute-force one link.
      const linkKey = createHash("sha256").update(data.token).digest("hex").slice(0, 16);
      const gate = await rateLimit(`sharepw:${linkKey}:${clientIp(getRequest())}`, 10, 900);
      if (!gate.ok) throw new Error(`Too many password attempts. Try again in ${Math.ceil(gate.retryAfter / 60)} minutes.`);
    }
    const content = await getSharedPageContent(data.token, data.password);
    if (!content) return { ok: false as const };

    // Empty string = empty page; the client renders its own localized empty state.
    let html = "";
    if (content.ydocState) {
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, content.ydocState);
      const editor = ServerBlockNoteEditor.create({ schema: createServerSchema() as any });
      const blocks = editor.yDocToBlocks(ydoc, "document-store");
      html = await editor.blocksToFullHTML(redactEmbedsForGuests(blocks) as any);
    }

    return { ok: true as const, title: content.page.title, icon: content.page.icon, html };
  });
