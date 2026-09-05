import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import * as z from "zod";
import { db } from "@kompast/db";
import {
  addTeamMember,
  listOrgMembersNotInTeam,
  listTeamMembers,
  listTeamsForWorkspace,
  removeTeamMember,
  requireSuperAdmin,
  requireTeamAdmin,
  setTeamMemberRole,
  transferSuperAdmin,
  withAuthorizedTenant,
} from "@kompast/core";
import { getAuth } from "../auth";
import { requireAuthContext } from "../session";

/**
 * team creation stays super-admin-only (createTeamFn). Team MEMBERSHIP
 * management (add/remove/promote) is gated to requireTeamAdmin — the
 * workspace super admin, or that specific team's own admin — now that
 * packages/core/src/team.ts's addTeamMember/removeTeamMember no longer call
 * into Better Auth's org+teams plugin endpoints at all (those endpoints
 * check the caller's WORKSPACE-level member.role, which a team's own admin
 * may not have; see team.ts's doc comment for the full reasoning). That
 * decoupling is what makes requireTeamAdmin safe to use here.
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
    await withAuthorizedTenant(ctx, async (tx) => {
      await addTeamMember(tx, { teamId: team.id, userId: ctx.userId, organizationId: ctx.organizationId });
      await setTeamMemberRole(tx, { teamId: team.id, userId: ctx.userId, role: "admin" });
    });

    return { id: team.id, name: team.name };
  });

export const listTeamsFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();
  return withAuthorizedTenant(ctx, (tx) => listTeamsForWorkspace(tx, ctx));
});

const teamIdSchema = z.object({ teamId: z.string() });

/** This team's roster + the workspace members eligible to be added — backs /teams/$teamId. */
export const getTeamManagementFn = createServerFn({ method: "GET" })
  .validator(teamIdSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireTeamAdmin(db, { ...ctx, teamId: data.teamId });
    return withAuthorizedTenant(ctx, async (tx) => ({
      members: await listTeamMembers(tx, data.teamId),
      candidates: await listOrgMembersNotInTeam(tx, ctx, data.teamId),
    }));
  });

const addTeamMemberSchema = z.object({ teamId: z.string(), userId: z.string() });

export const addTeamMemberFn = createServerFn({ method: "POST" })
  .validator(addTeamMemberSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireTeamAdmin(db, { ...ctx, teamId: data.teamId });
    await withAuthorizedTenant(ctx, (tx) =>
      addTeamMember(tx, { teamId: data.teamId, userId: data.userId, organizationId: ctx.organizationId }),
    );
    return { ok: true } as const;
  });

export const removeTeamMemberFn = createServerFn({ method: "POST" })
  .validator(addTeamMemberSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireTeamAdmin(db, { ...ctx, teamId: data.teamId });
    await withAuthorizedTenant(ctx, (tx) => removeTeamMember(tx, { teamId: data.teamId, userId: data.userId }));
    return { ok: true } as const;
  });

const setTeamMemberRoleSchema = z.object({ teamId: z.string(), userId: z.string(), role: z.enum(["admin", "member"]) });

export const setTeamMemberRoleFn = createServerFn({ method: "POST" })
  .validator(setTeamMemberRoleSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireTeamAdmin(db, { ...ctx, teamId: data.teamId });
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
