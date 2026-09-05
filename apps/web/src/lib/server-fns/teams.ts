import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import * as z from "zod";
import { db } from "@kompast/db";
import { listTeamsForWorkspace, requireSuperAdmin, setTeamMemberRole, transferSuperAdmin, withAuthorizedTenant } from "@kompast/core";
import { getAuth } from "../auth";
import { requireAuthContext } from "../session";

/**
 * team/team_member are Better Auth's own org+teams-plugin tables (like
 * invitation/apikey — see packages/db/rls.sql's own comments on those),
 * created through the plugin's own auth.api.createTeam/addTeamMember, never
 * a raw drizzle insert, so team.memberCount (plugin-managed) stays correct.
 * The one Kompast-only piece (team_member.role) is set right after via
 * setTeamMemberRole, since the plugin has no concept of it.
 *
 * Gated to requireSuperAdmin only, never requireTeamAdmin — team ADMINS can
 * create projects in their own team (see projects.ts's createProjectFn),
 * but never manage team membership itself. That split is also what keeps
 * this conflict-free with Better Auth's own permission model: addTeamMember
 * hard-requires the caller's member.role to grant "member:update", which
 * transferSuperAdmin guarantees for every super admin (see its own doc
 * comment in packages/core/src/permissions.ts) but never guarantees for a
 * plain team admin.
 */
const createTeamSchema = z.object({ name: z.string().min(1) });

export const createTeamFn = createServerFn({ method: "POST" })
  .validator(createTeamSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireSuperAdmin(db, ctx);

    const auth = await getAuth();
    const request = getRequest();
    const team = await auth.api.createTeam({
      body: { name: data.name, organizationId: ctx.organizationId },
      headers: request.headers,
    });
    await auth.api.addTeamMember({
      body: { teamId: team.id, userId: ctx.userId, organizationId: ctx.organizationId },
      headers: request.headers,
    });
    await setTeamMemberRole(db, { teamId: team.id, userId: ctx.userId, role: "admin" });

    return { id: team.id, name: team.name };
  });

export const listTeamsFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();
  return withAuthorizedTenant(ctx, (tx) => listTeamsForWorkspace(tx, ctx));
});

const addTeamMemberSchema = z.object({ teamId: z.string(), userId: z.string() });

export const addTeamMemberFn = createServerFn({ method: "POST" })
  .validator(addTeamMemberSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireSuperAdmin(db, ctx);

    const auth = await getAuth();
    const request = getRequest();
    await auth.api.addTeamMember({
      body: { teamId: data.teamId, userId: data.userId, organizationId: ctx.organizationId },
      headers: request.headers,
    });
    return { ok: true } as const;
  });

const setTeamMemberRoleSchema = z.object({ teamId: z.string(), userId: z.string(), role: z.enum(["admin", "member"]) });

export const setTeamMemberRoleFn = createServerFn({ method: "POST" })
  .validator(setTeamMemberRoleSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireSuperAdmin(db, ctx);
    await setTeamMemberRole(db, data);
    return { ok: true } as const;
  });

const transferSuperAdminSchema = z.object({ newHolderUserId: z.string() });

export const transferSuperAdminFn = createServerFn({ method: "POST" })
  .validator(transferSuperAdminSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => transferSuperAdmin(tx, ctx, data.newHolderUserId));
    return { ok: true } as const;
  });
