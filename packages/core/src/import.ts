import { and, eq, schema, type Json } from "@kompast/db";
import type { AnyDb, Tx } from "./types";
import { id } from "./ids";
import { ForbiddenError, type AuthContext } from "./permissions";

export type ImportSourceName = "jira" | "notion";
export type ImportEntityType = "issue" | "page" | "sprint" | "comment" | "worklog" | "attachment" | "user";

export interface CreateImportRunInput {
  organizationId: string;
  /** Null for page imports (Notion), which target a docs space rather than a project. */
  projectId: string | null;
  source: ImportSourceName;
  dryRun: boolean;
  /** Non-secret parameters only (project key, base URL) — never a credential. See packages/db/src/schema/import.ts. */
  config: Json;
  createdBy: string;
  /** Set when this run belongs to a JIRA migration (jira_migration). Omitted by one-shot imports. */
  migrationId?: string | null;
}

export async function createImportRun(tx: Tx, input: CreateImportRunInput) {
  const importRunId = id("imprun");
  await tx.insert(schema.importRun).values({
    id: importRunId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    source: input.source,
    dryRun: input.dryRun,
    config: input.config,
    createdBy: input.createdBy,
    migrationId: input.migrationId ?? null,
  });
  return { importRunId };
}

export async function markImportRunRunning(tx: Tx, importRunId: string) {
  await tx.update(schema.importRun).set({ status: "running", startedAt: new Date() }).where(eq(schema.importRun.id, importRunId));
}

export async function completeImportRun(tx: Tx, importRunId: string, counts: Json, errors: Json, notes?: Json) {
  await tx
    .update(schema.importRun)
    .set({ status: "completed", counts, errors, ...(notes !== undefined ? { notes } : {}), completedAt: new Date() })
    .where(eq(schema.importRun.id, importRunId));
}

/** AnyDb rather than Tx so the JIRA migration runner can fall back to the admin connection when the creator's own transaction is what failed. */
export async function failImportRun(tx: AnyDb, importRunId: string, error: string) {
  await tx
    .update(schema.importRun)
    .set({ status: "failed", errors: [{ error }], completedAt: new Date() })
    .where(eq(schema.importRun.id, importRunId));
}

export async function getImportRun(tx: Tx, importRunId: string) {
  const [row] = await tx.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
  return row ?? null;
}

export async function listImportRuns(tx: Tx, projectId: string) {
  return tx.select().from(schema.importRun).where(eq(schema.importRun.projectId, projectId));
}

/** Looks up the Kompast row a given external id already became, if this exact (source, sourceId) was seen before — the idempotency check every loader must make before creating anything. */
export async function resolveExternalRef(tx: Tx, organizationId: string, source: ImportSourceName, sourceId: string) {
  const [row] = await tx
    .select()
    .from(schema.externalRef)
    .where(and(eq(schema.externalRef.organizationId, organizationId), eq(schema.externalRef.source, source), eq(schema.externalRef.sourceId, sourceId)));
  return row ?? null;
}

export interface UpsertExternalRefInput {
  organizationId: string;
  source: ImportSourceName;
  sourceId: string;
  sourceUrl?: string;
  entityType: ImportEntityType;
  entityId: string;
  importRunId: string;
}

/** Records (or re-confirms) that `sourceId` maps to `entityId` — the ON CONFLICT is what makes re-running an import idempotent rather than erroring on the second pass. */
export async function upsertExternalRef(tx: Tx, input: UpsertExternalRefInput) {
  await tx
    .insert(schema.externalRef)
    .values({
      id: id("extref"),
      organizationId: input.organizationId,
      source: input.source,
      sourceId: input.sourceId,
      sourceUrl: input.sourceUrl,
      entityType: input.entityType,
      entityId: input.entityId,
      importRunId: input.importRunId,
    })
    .onConflictDoUpdate({
      target: [schema.externalRef.organizationId, schema.externalRef.source, schema.externalRef.sourceId],
      set: { entityId: input.entityId, sourceUrl: input.sourceUrl, importRunId: input.importRunId },
    });
}

/**
 * Where a page import (Notion) lands: the shared Workspace docs, the
 * caller's own Private space, or a team's space (`{ team }`, a team id).
 */
export type PageImportTarget = "workspace" | "private" | { team: string };

/**
 * The part of an import's external_ref key that names the target space:
 * `workspace`, `private:<userId>` or `team:<teamId>`. The Notion loader
 * appends `:<notionId>`. The workspace and private strings are the ones
 * earlier runs stored, so they must not change.
 */
export function pageImportTargetKey(target: PageImportTarget, actorUserId: string): string {
  if (target === "workspace") return "workspace";
  if (target === "private") return `private:${actorUserId}`;
  return `team:${target.team}`;
}

/**
 * Who may import into which docs space. Workspace docs are everyone's, so
 * filling them with a bulk import is reserved for workspace owners/admins
 * and the super admin, even though any member can create a single
 * Workspace page by hand. Private needs no check beyond membership: the
 * pages are owned by the caller (RLS refuses anyone else's Private space).
 * A team space is open to that team's members and the super admin, and
 * the team must belong to this workspace. Not to a workspace admin outside
 * the team: the page RLS policy only admits team members and the super
 * admin, so their inserts would fail on every page.
 */
export async function requirePageImportTarget(db: AnyDb, ctx: AuthContext, target: PageImportTarget): Promise<void> {
  if (target === "private") return;
  const [row] = await db
    .select({ role: schema.member.role, isSuperAdmin: schema.member.isSuperAdmin })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.userId, ctx.userId)));
  const isWorkspaceAdmin = !!row && (row.role === "owner" || row.role === "admin" || row.isSuperAdmin);

  if (target === "workspace") {
    if (!isWorkspaceAdmin) {
      throw new ForbiddenError("Only workspace admins can import into the Workspace docs. Import into your Private space instead.");
    }
    return;
  }

  const [team] = await db
    .select({ id: schema.team.id })
    .from(schema.team)
    .where(and(eq(schema.team.id, target.team), eq(schema.team.organizationId, ctx.organizationId)));
  if (!team) throw new ForbiddenError("That team is not in this workspace.");
  if (row?.isSuperAdmin) return;

  const [membership] = await db
    .select({ id: schema.teamMember.id })
    .from(schema.teamMember)
    .where(and(eq(schema.teamMember.teamId, target.team), eq(schema.teamMember.userId, ctx.userId)));
  if (!membership) {
    throw new ForbiddenError("Only members of that team can import into its space. Choose another team or import into your Private space.");
  }
}

/**
 * The placeholder email a former JIRA member gets: lowercase, with any character
 * outside [a-z0-9._-] replaced by "-", under the reserved .invalid domain so it can
 * never receive mail or match a real address.
 */
export function formerMemberEmail(accountId: string): string {
  const safe = accountId.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return `jira-${safe}@former.invalid`;
}

/**
 * Finds or creates the placeholder user for a former JIRA member: a `user` row
 * with no `member` row (so no workspace membership, which is how a departed
 * person is defined, see page-recovery.ts) and no `account` row (so they can't
 * sign in). Keyed by external_ref (source "jira", entityType "user", sourceId =
 * the JIRA accountId), so every batch and every re-run resolves to the same row.
 * If a user with the placeholder email already exists (a previous run whose
 * external_ref was lost), that row is reused rather than colliding on the unique
 * email. Users aren't RLS-scoped; the external_ref is, so this runs in the caller's tenant tx.
 */
export async function ensureImportedFormerUser(
  tx: Tx,
  input: { organizationId: string; accountId: string; name: string; importRunId: string },
): Promise<{ userId: string; created: boolean }> {
  const existing = await resolveExternalRef(tx, input.organizationId, "jira", input.accountId);
  if (existing && existing.entityType === "user") return { userId: existing.entityId, created: false };

  const email = formerMemberEmail(input.accountId);
  const [byEmail] = await tx.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));
  let userId = byEmail?.id;
  let created = false;
  if (!userId) {
    userId = id("user");
    await tx.insert(schema.user).values({ id: userId, name: input.name.trim() || "Former member", email, emailVerified: false });
    created = true;
  }

  await upsertExternalRef(tx, {
    organizationId: input.organizationId,
    source: "jira",
    sourceId: input.accountId,
    entityType: "user",
    entityId: userId,
    importRunId: input.importRunId,
  });
  return { userId, created };
}
