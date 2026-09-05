import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { and, db, eq, inArray, schema } from "@kompast/db";
import {
  createProject,
  ForbiddenError,
  getBoard,
  getOrCreateDefaultTableView,
  listIssuePropertyDefinitions,
  requireProjectAdmin,
  requireTeamAdmin,
  updateSavedViewConfig,
  withAuthorizedTenant,
} from "@kompast/core";
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

const createProjectSchema = z.object({
  teamId: z.string(),
  key: z.string().min(1).max(10),
  name: z.string().min(1),
  icon: z.string().optional(),
});

/**
 * requireTeamAdmin runs against plain `db` (team/team_member aren't
 * RLS-scoped, see packages/db/rls.sql) BEFORE opening the RLS-scoped tx —
 * project IS RLS-scoped, so the actual insert still goes through
 * withAuthorizedTenant like every other mutation.
 */
export const createProjectFn = createServerFn({ method: "POST" })
  .validator(createProjectSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireTeamAdmin(db, { ...ctx, teamId: data.teamId });
    return withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, {
        organizationId: ctx.organizationId,
        teamId: data.teamId,
        key: data.key,
        name: data.name,
        icon: data.icon,
        actorUserId: ctx.userId,
      }),
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

      const canManageProject = await requireProjectAdmin(tx, { ...ctx, projectId: project.id })
        .then(() => true)
        .catch((err) => {
          if (err instanceof ForbiddenError) return false;
          throw err;
        });

      const [issueTypes, boardData, tableView, propertyDefinitions] = await Promise.all([
        tx.select().from(schema.issueType).where(eq(schema.issueType.projectId, project.id)),
        getBoard(tx, board.id),
        getOrCreateDefaultTableView(tx, board.id, ctx.userId),
        listIssuePropertyDefinitions(tx, project.id),
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

      return { project, board, issueTypes, users, tableView, canManageProject, propertyDefinitions, ...boardData };
    });
  });

/** The picker list for inserting a kompastView embed — one board per project (P1 always creates exactly one). */
export const listEmbeddableBoardsFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();
  return withAuthorizedTenant(ctx, (tx) =>
    tx
      .select({ boardId: schema.board.id, projectKey: schema.project.key, projectName: schema.project.name })
      .from(schema.board)
      .innerJoin(schema.project, eq(schema.project.id, schema.board.projectId))
      .where(eq(schema.project.organizationId, ctx.organizationId)),
  );
});

/**
 * Backs the kompastView doc embed (apps/web/src/components/docs/KompastViewBlock.tsx).
 * Re-derives the reader's own access from ctx (their real session, not
 * anything trusted from the block's stored props) exactly like
 * getProjectBoardFn — an embed must never grant more than the viewer could
 * already see by navigating to the board directly (see plan §"Board <->
 * Table <-> Doc embed").
 */
export const getBoardEmbedDataFn = createServerFn({ method: "GET" })
  .validator((boardId: string) => boardId)
  .handler(async ({ data: boardId }) => {
    const ctx = await requireAuthContext();

    return withAuthorizedTenant(ctx, async (tx) => {
      const [board] = await tx.select().from(schema.board).where(eq(schema.board.id, boardId));
      if (!board) throw new Error(`Board ${boardId} not found`);

      const [project] = await tx
        .select()
        .from(schema.project)
        .where(and(eq(schema.project.id, board.projectId), eq(schema.project.organizationId, ctx.organizationId)));
      if (!project) throw new Error(`Board ${boardId} not found`);

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
