import { createHash } from "node:crypto";
import { adminDb, and, eq, isNull, or, gt, schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";
import { hashPasswordAsync, verifyPasswordAsync } from "./crypto";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type ShareLinkAccess = "signed_in" | "public";

export interface CreateShareLinkInput {
  pageId: string;
  scope?: "view" | "comment";
  /**
   * "signed_in" unless the caller explicitly asks for "public". Secure by
   * default: a link only opens for someone with a Kompast session, and a
   * public (no sign-in) link is an opt-in the UI confirms first.
   */
  access?: ShareLinkAccess;
  includeEmbeds?: boolean;
  password?: string;
  expiresAt?: Date | null;
  createdBy: string;
}

/** Raw token is returned once — only its hash is ever stored, same pattern as apiKey PATs. */
export async function createShareLink(tx: Tx, input: CreateShareLinkInput) {
  const token = id("share");
  const shareLinkId = id("sharelink");

  await tx.insert(schema.shareLink).values({
    id: shareLinkId,
    pageId: input.pageId,
    tokenHash: hashToken(token),
    scope: input.scope ?? "view",
    access: input.access ?? "signed_in",
    includeEmbeds: input.includeEmbeds ?? false,
    passwordHash: input.password ? await hashPasswordAsync(input.password) : null,
    expiresAt: input.expiresAt ?? null,
    createdBy: input.createdBy,
  });

  return { id: shareLinkId, token };
}

/** Never returns tokenHash or passwordHash — this is for the "manage share links" UI, not verification. */
export async function listShareLinks(tx: Tx, pageId: string) {
  return tx
    .select({
      id: schema.shareLink.id,
      scope: schema.shareLink.scope,
      access: schema.shareLink.access,
      includeEmbeds: schema.shareLink.includeEmbeds,
      hasPassword: schema.shareLink.passwordHash,
      expiresAt: schema.shareLink.expiresAt,
      revokedAt: schema.shareLink.revokedAt,
      createdBy: schema.shareLink.createdBy,
      createdAt: schema.shareLink.createdAt,
    })
    .from(schema.shareLink)
    .where(eq(schema.shareLink.pageId, pageId))
    .then((rows) => rows.map(({ hasPassword, ...r }) => ({ ...r, hasPassword: hasPassword !== null })));
}

export async function revokeShareLink(tx: Tx, shareLinkId: string) {
  await tx.update(schema.shareLink).set({ revokedAt: new Date() }).where(eq(schema.shareLink.id, shareLinkId));
}

/**
 * The ONE query path in this codebase that deliberately runs with no
 * workspace/session context at all — see plan §Auth, "Guests are not
 * sessions" and packages/db's `adminDb` doc comment. The raw token is the
 * entire credential: hash it, look up the row, and reject on anything but
 * an exact match plus not-revoked/not-expired/page-not-archived. Never widen this query.
 */
export async function resolveShareLink(token: string) {
  const [row] = await adminDb
    .select({ shareLink: schema.shareLink, page: schema.page })
    .from(schema.shareLink)
    .innerJoin(schema.page, eq(schema.page.id, schema.shareLink.pageId))
    .where(
      and(
        eq(schema.shareLink.tokenHash, hashToken(token)),
        isNull(schema.shareLink.revokedAt),
        or(isNull(schema.shareLink.expiresAt), gt(schema.shareLink.expiresAt, new Date())),
        // A trashed page stops being public — restoring it brings the link back.
        isNull(schema.page.archivedAt),
      ),
    );
  return row ?? null;
}

/** A signed-in link opens only for a viewer with a session; public links open for anyone. */
export function shareLinkAllowsViewer(shareLink: { access: ShareLinkAccess }, viewerUserId: string | null): boolean {
  return shareLink.access === "public" || viewerUserId !== null;
}

export type SharedPageMeta =
  | { status: "not_found" }
  | { status: "login_required" }
  | { status: "ok"; title: string; icon: string | null; requiresPassword: boolean };

/**
 * What the guest route may show before content is unlocked. A signed-in link
 * opened without a session reveals nothing about the page (no title, icon or
 * password hint), only that signing in is needed.
 */
export async function getSharedPageMeta(token: string, viewerUserId: string | null): Promise<SharedPageMeta> {
  const resolved = await resolveShareLink(token);
  if (!resolved) return { status: "not_found" };
  if (!shareLinkAllowsViewer(resolved.shareLink, viewerUserId)) return { status: "login_required" };
  return {
    status: "ok",
    title: resolved.page.title,
    icon: resolved.page.icon,
    requiresPassword: shareLinkRequiresPassword(resolved.shareLink),
  };
}

export function shareLinkRequiresPassword(shareLink: { passwordHash: string | null }): boolean {
  return shareLink.passwordHash !== null;
}

export async function checkSharePassword(shareLink: { passwordHash: string | null }, candidate: string): Promise<boolean> {
  if (!shareLink.passwordHash) return true;
  return verifyPasswordAsync(candidate, shareLink.passwordHash);
}

/**
 * Resolves a token, checks who may open it (sign-in before password) AND
 * checks its password in one call, then hands back
 * the raw Yjs bytes for the guest route to render — still entirely off the
 * admin connection, never withAuthorizedTenant. BlockNote-specific
 * conversion (bytes -> HTML) happens in apps/web, which is the only
 * package allowed to depend on @blocknote/*.
 */
export async function getSharedPageContent(
  token: string,
  opts: { password?: string; viewerUserId: string | null },
) {
  const resolved = await resolveShareLink(token);
  if (!resolved) return { status: "not_found" as const };
  if (!shareLinkAllowsViewer(resolved.shareLink, opts.viewerUserId)) return { status: "login_required" as const };
  // A wrong password reads the same as a bad token: nothing confirms the link exists.
  if (!(await checkSharePassword(resolved.shareLink, opts.password ?? ""))) return { status: "not_found" as const };

  const [row] = await adminDb.select().from(schema.ydocState).where(eq(schema.ydocState.pageId, resolved.page.id));
  return { status: "ok" as const, page: resolved.page, shareLink: resolved.shareLink, ydocState: row?.state ?? null };
}
