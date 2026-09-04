import { createHash } from "node:crypto";
import { adminDb, and, eq, isNull, or, gt, schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";
import { hashPassword, verifyPassword } from "./crypto";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreateShareLinkInput {
  pageId: string;
  scope?: "view" | "comment";
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
    includeEmbeds: input.includeEmbeds ?? false,
    passwordHash: input.password ? hashPassword(input.password) : null,
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
 * an exact match plus not-revoked/not-expired. Never widen this query.
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
      ),
    );
  return row ?? null;
}

export function shareLinkRequiresPassword(shareLink: { passwordHash: string | null }): boolean {
  return shareLink.passwordHash !== null;
}

export function checkSharePassword(shareLink: { passwordHash: string | null }, candidate: string): boolean {
  if (!shareLink.passwordHash) return true;
  return verifyPassword(candidate, shareLink.passwordHash);
}

/**
 * Resolves a token AND checks its password in one call, then hands back
 * the raw Yjs bytes for the guest route to render — still entirely off the
 * admin connection, never withAuthorizedTenant. BlockNote-specific
 * conversion (bytes -> HTML) happens in apps/web, which is the only
 * package allowed to depend on @blocknote/*.
 */
export async function getSharedPageContent(token: string, password?: string) {
  const resolved = await resolveShareLink(token);
  if (!resolved) return null;
  if (!checkSharePassword(resolved.shareLink, password ?? "")) return null;

  const [row] = await adminDb.select().from(schema.ydocState).where(eq(schema.ydocState.pageId, resolved.page.id));
  return { page: resolved.page, shareLink: resolved.shareLink, ydocState: row?.state ?? null };
}
