import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray, schema } from "@kompast/db";
import { getBoard, withAuthorizedTenant } from "@kompast/core";
import { requireAuthContext } from "../session";

export const listProjectsFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();
  return withAuthorizedTenant(ctx, (tx) =>
    tx
      .select({ id: schema.project.id, key: schema.project.key, name: schema.project.name })
      .from(schema.project)
      .where(eq(schema.project.organizationId, ctx.organizationId)),
  );
});

export const getProjectBoardFn = createServerFn({ method: "GET" })
  .validator((projectKey: string) => projectKey)
  .handler(async ({ data: projectKey }) => {
    const ctx = await requireAuthContext();

    return withAuthorizedTenant(ctx, async (tx) => {
      const [project] = await tx
        .select()
        .from(schema.project)
        .where(and(eq(schema.project.organizationId, ctx.organizationId), eq(schema.project.key, projectKey.toUpperCase())));
      if (!project) throw new Error(`Project ${projectKey} not found`);

      const [board] = await tx.select().from(schema.board).where(eq(schema.board.projectId, project.id));
      if (!board) throw new Error(`Project ${projectKey} has no board`);

      const [issueTypes, boardData] = await Promise.all([
        tx.select().from(schema.issueType).where(eq(schema.issueType.projectId, project.id)),
        getBoard(tx, board.id),
      ]);

      const assigneeIds = [
        ...new Set(
          boardData.columns.flatMap((c) => c.issues.map((i) => i.assigneeId).filter((id): id is string => !!id)),
        ),
      ];
      const users =
        assigneeIds.length > 0
          ? await tx
              .select({ id: schema.user.id, name: schema.user.name })
              .from(schema.user)
              .where(inArray(schema.user.id, assigneeIds))
          : [];

      return { project, board, issueTypes, users, ...boardData };
    });
  });
