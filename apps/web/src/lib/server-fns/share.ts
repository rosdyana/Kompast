import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createHash } from "node:crypto";
import * as z from "zod";
import * as Y from "yjs";
import { getSharedPageMeta, getSharedPageContent, UserFacingError } from "@kompast/core";
import { redactEmbedsForGuests } from "../blocknote-schema";
import { createServerEditor } from "../server-editor";
import { clientIp, rateLimit } from "../rate-limit";
import { sanitizeShareHtml } from "../share-html";
import { getCurrentSession } from "../session";

/**
 * Any valid Kompast session counts as signed in for a "signed_in" link — the
 * viewer needn't be in this page's workspace, team or access list, nor even
 * have an active workspace. Read on every call; never trust the meta call's answer.
 */
async function viewerUserId(): Promise<string | null> {
  const session = await getCurrentSession();
  return session?.user.id ?? null;
}

/**
 * Reachable without a session — no requireAuthContext, no
 * withAuthorizedTenant. Whether a link needs sign-in is the link's own
 * `access`, enforced in core (getSharedPageMeta / getSharedPageContent). Deliberately split from getSharedPageContentFn so
 * the browser can check "does this link exist / need a password" without
 * ever sending a password over a GET request.
 */
export const getSharedPageMetaFn = createServerFn({ method: "GET" })
  .validator((token: string) => token)
  .handler(async ({ data: token }) => {
    const meta = await getSharedPageMeta(token, await viewerUserId());
    if (meta.status === "not_found") return null;
    if (meta.status === "login_required") return { loginRequired: true as const };
    return { loginRequired: false as const, title: meta.title, icon: meta.icon, requiresPassword: meta.requiresPassword };
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
      if (!gate.ok) throw new UserFacingError(`Too many password attempts. Try again in ${Math.ceil(gate.retryAfter / 60)} minutes.`);
    }
    const content = await getSharedPageContent(data.token, { password: data.password, viewerUserId: await viewerUserId() });
    if (content.status === "login_required") return { ok: false as const, loginRequired: true as const };
    if (content.status !== "ok") return { ok: false as const, loginRequired: false as const };

    // Empty string = empty page; the client renders its own localized empty state.
    let html = "";
    if (content.ydocState) {
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, content.ydocState);
      const editor = createServerEditor();
      const blocks = editor.yDocToBlocks(ydoc, "document-store");
      // Page content is user-authored and this URL is public: the HTML is
      // rendered with dangerouslySetInnerHTML, so it must be inert here.
      html = sanitizeShareHtml(await editor.blocksToFullHTML(redactEmbedsForGuests(blocks) as any));
    }

    return { ok: true as const, title: content.page.title, icon: content.page.icon, html };
  });
