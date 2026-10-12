import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { and, count, db, eq, schema } from "@kompast/db";
import { listTeamsForWorkspace, renameWorkspace, requireSystemAdmin, withAuthorizedTenant } from "@kompast/core";
import { getCurrentSession, requireAuthContext } from "../session";

export const getWorkspaceShellFn = createServerFn({ method: "GET" }).handler(async () => {
  const session = await getCurrentSession();
  if (!session || !session.organizationId) return null;

  const ctx = { userId: session.user.id, organizationId: session.organizationId };
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
    user: { id: session.user.id, name: session.user.name },
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
