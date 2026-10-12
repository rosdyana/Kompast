import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import * as z from "zod";
import { db, eq, schema } from "@kompast/db";
import {
  addTeamMember,
  cancelTeamInvitation,
  createTeamInvitation,
  deleteTeam,
  getTeamDeletionImpact,
  listTeamInvitations,
  listOrgMembersNotInTeam,
  listTeamMembers,
  listTeamsForWorkspace,
  removeTeamMember,
  renameTeam,
  requireSuperAdmin,
  requireTeamAdmin,
  setTeamMemberRole,
  transferSuperAdmin,
  withAuthorizedTenant,
} from "@kompast/core";
import { getAuth, sendInvitationEmail } from "../auth";
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
      invitations: await listTeamInvitations(tx, data.teamId),
    }));
  });

const renameTeamSchema = z.object({ teamId: z.string(), name: z.string() });

/** Team admins can rename their own team; the super admin any team. */
export const renameTeamFn = createServerFn({ method: "POST" })
  .validator(renameTeamSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireTeamAdmin(db, { ...ctx, teamId: data.teamId });
    return withAuthorizedTenant(ctx, (tx) => renameTeam(tx, { organizationId: ctx.organizationId, teamId: data.teamId, name: data.name }));
  });

/** Backs the delete-team confirmation dialog — super admin only, like deleteTeamFn itself. */
export const getTeamDeletionImpactFn = createServerFn({ method: "GET" })
  .validator(teamIdSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireSuperAdmin(db, ctx);
    return withAuthorizedTenant(ctx, (tx) => getTeamDeletionImpact(tx, { organizationId: ctx.organizationId, teamId: data.teamId }));
  });

const deleteTeamSchema = z.object({ teamId: z.string(), transferToTeamId: z.string().optional() });

export const deleteTeamFn = createServerFn({ method: "POST" })
  .validator(deleteTeamSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireSuperAdmin(db, ctx);
    await withAuthorizedTenant(ctx, (tx) =>
      deleteTeam(tx, { organizationId: ctx.organizationId, teamId: data.teamId, transferToTeamId: data.transferToTeamId }),
    );
    return { ok: true } as const;
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

const inviteToTeamSchema = z.object({ teamId: z.string(), email: z.email(), teamRole: z.enum(["admin", "member"]) });

/**
 * A team admin (or the super admin) inviting someone new: they join the
 * workspace as a plain member and land in this team with `teamRole`. See
 * packages/core/src/team.ts createTeamInvitation for why this doesn't go
 * through auth.api.createInvitation.
 */
export const inviteToTeamFn = createServerFn({ method: "POST" })
  .validator(inviteToTeamSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireTeamAdmin(db, { ...ctx, teamId: data.teamId });
    const { id, created } = await withAuthorizedTenant(ctx, (tx) =>
      createTeamInvitation(tx, { organizationId: ctx.organizationId, teamId: data.teamId, email: data.email, teamRole: data.teamRole, inviterId: ctx.userId }),
    );
    if (created) {
      const [org] = await db.select({ id: schema.organization.id, name: schema.organization.name }).from(schema.organization).where(eq(schema.organization.id, ctx.organizationId));
      const [inviter] = await db.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, ctx.userId));
      await sendInvitationEmail({ id, role: data.teamRole, email: data.email, organization: org!, inviter: { userId: ctx.userId, user: { name: inviter?.name ?? "" } } });
    }
    return { id, created };
  });

const cancelTeamInvitationSchema = z.object({ teamId: z.string(), invitationId: z.string() });

export const cancelTeamInvitationFn = createServerFn({ method: "POST" })
  .validator(cancelTeamInvitationSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireTeamAdmin(db, { ...ctx, teamId: data.teamId });
    await cancelTeamInvitation(db, data);
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
