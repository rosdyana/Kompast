import { createServerFn } from "@tanstack/react-start";
import { count, eq, schema } from "@kompast/db";
import { withAuthorizedTenant } from "@kompast/core";
import { getCurrentSession } from "../session";

export const getWorkspaceShellFn = createServerFn({ method: "GET" }).handler(async () => {
  const session = await getCurrentSession();
  if (!session || !session.organizationId) return null;

  const ctx = { userId: session.user.id, organizationId: session.organizationId };
  const [organization, memberCountRow, projects] = await withAuthorizedTenant(ctx, async (tx) => [
    (await tx.select().from(schema.organization).where(eq(schema.organization.id, ctx.organizationId)))[0],
    (await tx.select({ n: count() }).from(schema.member).where(eq(schema.member.organizationId, ctx.organizationId)))[0],
    await tx
      .select({ id: schema.project.id, key: schema.project.key, name: schema.project.name })
      .from(schema.project)
      .where(eq(schema.project.organizationId, ctx.organizationId)),
  ]);

  return {
    user: { id: session.user.id, name: session.user.name },
    organization: organization ?? null,
    memberCount: memberCountRow?.n ?? 0,
    projects,
  };
});
