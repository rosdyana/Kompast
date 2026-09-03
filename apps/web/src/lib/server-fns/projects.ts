import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { and, eq, inArray, schema } from "@kompast/db";
import { getBoard, getOrCreateDefaultTableView, updateSavedViewConfig, withAuthorizedTenant } from "@kompast/core";
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

      const [issueTypes, boardData, tableView] = await Promise.all([
        tx.select().from(schema.issueType).where(eq(schema.issueType.projectId, project.id)),
        getBoard(tx, board.id),
        getOrCreateDefaultTableView(tx, board.id, ctx.userId),
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

      return { project, board, issueTypes, users, tableView, ...boardData };
    });
  });

const updateTableViewSchema = z.object({
  viewId: z.string(),
  groupBy: z.enum(["column", "assignee", "none"]),
  sortBy: z.enum(["rank", "priority", "dueDate", "points", "key"]),
  sortDir: z.enum(["asc", "desc"]),
});

export const updateTableViewFn = createServerFn({ method: "POST" })
  .validator(updateTableViewSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) =>
      updateSavedViewConfig(tx, data.viewId, {
        groupBy: data.groupBy,
        sortBy: data.sortBy,
        sortDir: data.sortDir,
      }),
    );
    return { ok: true } as const;
  });
