import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { and, db, eq, inArray, schema } from "@kompast/db";
import {
  createProject,
  createPage,
  setSprintMinutesTemplate,
  setSprintRetroTemplate,
  ForbiddenError,
  getBoard,
  getOrCreateDefaultTableView,
  getProjectByTeamAndKey,
  listIssuePropertyDefinitions,
  listPriorityLevels,
  listSprints,
  listSprintIssues,
  requireProjectAdmin,
  requireTeamAdmin,
  updateSavedViewConfig,
  withAuthorizedTenant,
  type FilterCondition,
} from "@kompast/core";
import { seedPageContentFromMarkdown } from "../seed-page-content";
import { requireAuthContext } from "../session";

export const listProjectsFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();
  return withAuthorizedTenant(ctx, (tx) =>
    tx
      .select({ id: schema.project.id, key: schema.project.key, name: schema.project.name, teamId: schema.project.teamId })
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
    try {
      return await withAuthorizedTenant(ctx, async (tx) => {
        const created = await createProject(tx, {
          organizationId: ctx.organizationId,
          teamId: data.teamId,
          key: data.key,
          name: data.name,
          icon: data.icon,
          actorUserId: ctx.userId,
        });

        // Best-effort: a docs-side failure here (e.g. a BlockNote/jsdom
        // construction error) must never block project creation itself —
        // same principle createLinkedMinutesPage (packages/core/src/sprint.ts)
        // already applies one layer down. A project with no template just
        // means its sprints get blank minutes docs instead of pre-seeded ones.
        try {
          const templatePage = await createPage(tx, {
            organizationId: ctx.organizationId,
            projectId: created.projectId,
            title: "Sprint Minutes Template",
            type: "template",
            actorUserId: ctx.userId,
          });
          await seedPageContentFromMarkdown(tx, templatePage.id, "# Planning\n\n# Review\n\n# Retro\n");
          await setSprintMinutesTemplate(tx, created.projectId, templatePage.id);
        } catch (err) {
          console.error(`Failed to seed Sprint Minutes Template for project ${created.projectId}:`, err);
        }

        // Same best-effort shape as the Sprint Minutes Template above, for
        // the Sprint Retrospective doc's default sections.
        try {
          const retroTemplatePage = await createPage(tx, {
            organizationId: ctx.organizationId,
            projectId: created.projectId,
            title: "Sprint Retrospective Template",
            type: "template",
            actorUserId: ctx.userId,
          });
          await seedPageContentFromMarkdown(tx, retroTemplatePage.id, "# Went Well\n\n# To Improve\n\n# Action Items\n");
          await setSprintRetroTemplate(tx, created.projectId, retroTemplatePage.id);
        } catch (err) {
          console.error(`Failed to seed Sprint Retrospective Template for project ${created.projectId}:`, err);
        }

        return created;
      });
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      if (code === "23505") throw new Error(`A project with key "${data.key.toUpperCase()}" already exists on this team.`);
      throw err;
    }
  });

export const getProjectBoardFn = createServerFn({ method: "GET" })
  .validator((input: { teamId: string; projectKey: string }) => input)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    const { projectKey } = data;

    return withAuthorizedTenant(ctx, async (tx) => {
      const project = await getProjectByTeamAndKey(tx, {
        organizationId: ctx.organizationId,
        teamId: data.teamId === "none" ? null : data.teamId,
        key: projectKey,
      });
      if (!project) throw new Error(`Project ${projectKey} not found`);

      const [board] = await tx.select().from(schema.board).where(eq(schema.board.projectId, project.id));
      if (!board) throw new Error(`Project ${projectKey} has no board`);

      const canManageProject = await requireProjectAdmin(tx, { ...ctx, projectId: project.id })
        .then(() => true)
        .catch((err) => {
          if (err instanceof ForbiddenError) return false;
          throw err;
        });

      const [issueTypes, boardData, tableView, propertyDefinitions, sprints, priorityLevels] = await Promise.all([
        tx.select().from(schema.issueType).where(eq(schema.issueType.projectId, project.id)),
        getBoard(tx, board.id),
        getOrCreateDefaultTableView(tx, board.id, ctx.userId),
        listIssuePropertyDefinitions(tx, project.id),
        listSprints(tx, board.id),
        listPriorityLevels(tx, project.id),
      ]);

      const activeSprint = sprints.find((s) => s.state === "active") ?? null;
      const activeSprintIssueIds = activeSprint ? (await listSprintIssues(tx, activeSprint.id)).map((i) => i.id) : [];

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

      // Distinct from `users` (assignees of currently-visible issues, no
      // email) — this is the actual project membership, with email, used to
      // default the Sprint Review "Send by Email" recipient list.
      const projectMembers = await tx
        .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
        .from(schema.projectMember)
        .innerJoin(schema.user, eq(schema.user.id, schema.projectMember.userId))
        .where(eq(schema.projectMember.projectId, project.id));

      return {
        project,
        board,
        issueTypes,
        users,
        projectMembers,
        tableView,
        canManageProject,
        propertyDefinitions,
        priorityLevels,
        hasAnySprint: sprints.length > 0,
        activeSprint,
        activeSprintIssueIds,
        ...boardData,
      };
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

      const [issueTypes, boardData, tableView, priorityLevels] = await Promise.all([
        tx.select().from(schema.issueType).where(eq(schema.issueType.projectId, project.id)),
        getBoard(tx, board.id),
        getOrCreateDefaultTableView(tx, board.id, ctx.userId),
        listPriorityLevels(tx, project.id),
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

      return { project, board, issueTypes, users, tableView, priorityLevels, ...boardData };
    });
  });

const sortRuleSchema = z.object({
  field: z.enum(["manual", "priority", "dueDate", "points", "key"]),
  direction: z.enum(["asc", "desc"]),
});

const filterConditionSchema = z.object({
  id: z.string(),
  field: z.enum(["column", "assignee", "priority", "type", "points", "dueDate", "title"]),
  operator: z.enum(["is", "isNot", "isAnyOf", "contains", "doesNotContain", "isEmpty", "isNotEmpty", "gt", "gte", "lt", "lte", "before", "after"]),
  value: z.unknown(),
});

const updateTableViewSchema = z.object({
  viewId: z.string(),
  groupBy: z.enum(["column", "assignee", "none"]),
  sort: z.array(sortRuleSchema),
  filters: z.array(filterConditionSchema),
});

export const updateTableViewFn = createServerFn({ method: "POST" })
  .validator(updateTableViewSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) =>
      updateSavedViewConfig(tx, data.viewId, {
        groupBy: data.groupBy,
        sort: data.sort,
        filters: data.filters as FilterCondition[],
      }),
    );
    return { ok: true } as const;
  });
