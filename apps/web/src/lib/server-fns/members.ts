import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import * as z from "zod";
import { db, schema, eq } from "@kompast/db";
import { requireSystemAdmin } from "@kompast/core";
import { getAuth } from "../auth";
import { requireAuthContext } from "../session";

/**
 * member/user aren't RLS-scoped (they're Better Auth's own tables, same
 * exception class as apikey/invitation — see rls.sql) so this filters by
 * organizationId explicitly via plain `db`, matching the existing pattern
 * in server-fns/settings.ts (requireSystemAdmin(db, ctx), no
 * withAuthorizedTenant).
 */
export const listMembersFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();
  await requireSystemAdmin(db, ctx);

  const auth = await getAuth();
  const request = getRequest();

  const [members, invitations] = await Promise.all([
    db
      .select({ id: schema.member.id, userId: schema.member.userId, role: schema.member.role, name: schema.user.name, email: schema.user.email })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.member.organizationId, ctx.organizationId)),
    auth.api.listInvitations({ query: { organizationId: ctx.organizationId }, headers: request.headers }),
  ]);

  return { members, invitations: invitations.filter((i) => i.status === "pending") };
});

const inviteSchema = z.object({ email: z.email(), role: z.enum(["member", "admin"]) });

export const inviteMemberFn = createServerFn({ method: "POST" })
  .validator(inviteSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireSystemAdmin(db, ctx);

    const auth = await getAuth();
    const request = getRequest();
    const invitation = await auth.api.createInvitation({ body: { email: data.email, role: data.role, organizationId: ctx.organizationId }, headers: request.headers });
    return { id: invitation.id };
  });

export const cancelInvitationFn = createServerFn({ method: "POST" })
  .validator((invitationId: string) => invitationId)
  .handler(async ({ data: invitationId }) => {
    const ctx = await requireAuthContext();
    await requireSystemAdmin(db, ctx);

    const auth = await getAuth();
    const request = getRequest();
    await auth.api.cancelInvitation({ body: { invitationId }, headers: request.headers });
    return { ok: true } as const;
  });
