import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { and, count, db, eq, schema } from "@kompast/db";
import { listTeamsForWorkspace, renameWorkspace, requireSystemAdmin, withAuthorizedTenant } from "@kompast/core";
import { getCurrentSession, requireAuthContext } from "../session";

/**
 * Where a request lands for the workspace shell: no session → "anonymous"
 * (the loader sends them to /login); a session with no active workspace →
 * "noWorkspace" (signed in but has no membership yet, sent to /no-workspace,
 * not back to /login, which would look like sign-in is broken); otherwise
 * "workspace". Pure, so the gate is testable without the server-fn transport.
 */
export function workspaceEntryFor<T extends { organizationId: string | null }>(
  session: T | null,
):
  | { kind: "anonymous" }
  | { kind: "noWorkspace" }
  | { kind: "workspace"; session: T & { organizationId: string } } {
  if (!session) return { kind: "anonymous" };
  if (!session.organizationId) return { kind: "noWorkspace" };
  return { kind: "workspace", session: session as T & { organizationId: string } };
}

export const getWorkspaceShellFn = createServerFn({ method: "GET" }).handler(async () => {
  const entry = workspaceEntryFor(await getCurrentSession());
  if (entry.kind === "anonymous") return null;
  if (entry.kind === "noWorkspace") return { noWorkspace: true as const };
  const active = entry.session;

  const ctx = { userId: active.user.id, organizationId: active.organizationId };
  const [organization, memberCountRow, projects, membership, teams] = await withAuthorizedTenant(ctx, async (tx) => [
    (await tx.select().from(schema.organization).where(eq(schema.organization.id, ctx.organizationId)))[0],
    (await tx.select({ n: count() }).from(schema.member).where(eq(schema.member.organizationId, ctx.organizationId)))[0],
    await tx
      .select({ id: schema.project.id, key: schema.project.key, name: schema.project.name, teamId: schema.project.teamId })
      .from(schema.project)
      .where(eq(schema.project.organizationId, ctx.organizationId)),
    (
      await tx
        .select({ role: schema.member.role, isSuperAdmin: schema.member.isSuperAdmin })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.userId, ctx.userId)))
    )[0],
    await listTeamsForWorkspace(tx, ctx),
  ]);

  const role = membership?.role ?? "member";

  return {
    user: { id: active.user.id, name: active.user.name },
    organization: organization ?? null,
    memberCount: memberCountRow?.n ?? 0,
    projects,
    teams,
    isAdmin: role === "owner" || role === "admin",
    isSuperAdmin: membership?.isSuperAdmin ?? false,
  };
});

const renameWorkspaceSchema = z.object({ name: z.string() });

/** Workspace owner/admin only — the same gate as the rest of /settings. */
export const renameWorkspaceFn = createServerFn({ method: "POST" })
  .validator(renameWorkspaceSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireSystemAdmin(db, ctx);
    return withAuthorizedTenant(ctx, (tx) => renameWorkspace(tx, { organizationId: ctx.organizationId, name: data.name }));
  });
