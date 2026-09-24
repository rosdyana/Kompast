import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { and, asc, eq, inArray, ne, schema, type Json } from "@kompast/db";
import {
  moveIssue as moveIssueCore,
  createIssue as createIssueCore,
  updateIssue,
  addIssueToSprint,
  listCandidateEpics,
  listPriorityLevels,
  withAuthorizedTenant,
} from "@kompast/core";
import { requireAuthContext } from "../session";

const moveIssueSchema = z.object({
  issueId: z.string(),
  toStatusId: z.string(),
  beforeIssueId: z.string().optional(),
  afterIssueId: z.string().optional(),
  /** Set only for a swimlane-grouped drag — see BoardView's handleDragEnd. */
  assigneeId: z.string().nullable().optional(),
});

export const moveIssueFn = createServerFn({ method: "POST" })
  .validator(moveIssueSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) =>
      moveIssueCore(tx, {
        issueId: data.issueId,
        toStatusId: data.toStatusId,
        beforeIssueId: data.beforeIssueId,
        afterIssueId: data.afterIssueId,
        assigneeId: data.assigneeId,
        actorId: ctx.userId,
        origin: "user",
      }),
    );
    return { ok: true } as const;
  });

const createIssueSchema = z.object({
  projectId: z.string(),
  typeId: z.string(),
  /** Omit to land in the board's Backlog column (the usual entry point). */
  statusId: z.string().optional(),
  title: z.string().trim().min(1),
  assigneeId: z.string().optional(),
  priority: z.string().optional(),
  storyPoints: z.number().min(0).optional(),
  dueDate: z.coerce.date().optional(),
  labels: z.array(z.string()).optional(),
  descriptionJson: z.unknown().optional(),
  epicId: z.string().optional(),
  parentId: z.string().optional(),
  /** Added to this sprint right after creation (same transaction). */
  sprintId: z.string().optional(),
});

/**
 * One transaction over the existing core mutations — createIssue, then
 * (optionally) updateIssue for the epic link and addIssueToSprint — so the
 * create dialog's extra fields can never half-apply. Each step keeps its
 * own history row and automation event, exactly as if done one by one.
 */
export const createIssueFn = createServerFn({ method: "POST" })
  .validator(createIssueSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      const statusId = data.statusId ?? (await backlogStatusIdForProject(tx, data.projectId));
      if (!statusId) throw new Error("This project's board has no Backlog column to create issues in.");
      const created = await createIssueCore(tx, {
        organizationId: ctx.organizationId,
        projectId: data.projectId,
        typeId: data.typeId,
        statusId,
        title: data.title,
        reporterId: ctx.userId,
        assigneeId: data.assigneeId,
        priority: data.priority,
        storyPoints: data.storyPoints,
        dueDate: data.dueDate,
        labels: data.labels,
        descriptionJson: data.descriptionJson as Json | undefined,
        parentId: data.parentId,
      });
      if (data.epicId) {
        await updateIssue(tx, created.issueId, { epicId: data.epicId, actorId: ctx.userId, origin: "user" });
      }
      if (data.sprintId) {
        await addIssueToSprint(tx, data.sprintId, created.issueId, { actorId: ctx.userId });
      }
      return created;
    });
  });

async function backlogStatusIdForProject(tx: Parameters<Parameters<typeof withAuthorizedTenant>[1]>[0], projectId: string) {
  const [row] = await tx
    .select({ statusId: schema.boardColumnStatus.workflowStatusId })
    .from(schema.board)
    .innerJoin(schema.boardColumn, eq(schema.boardColumn.boardId, schema.board.id))
    .innerJoin(schema.boardColumnStatus, eq(schema.boardColumnStatus.boardColumnId, schema.boardColumn.id))
    .where(and(eq(schema.board.projectId, projectId), eq(schema.boardColumn.isBacklog, true)))
    .limit(1);
  return row?.statusId ?? null;
}

/**
 * Everything the global "Create issue" dialog needs for one project, in a
 * single round trip: types, priority levels, assignable members, open
 * sprints, epics, and the project's key.
 */
export const getCreateIssueContextFn = createServerFn({ method: "GET" })
  .validator((projectId: string) => projectId)
  .handler(async ({ data: projectId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      const [project] = await tx
        .select({ id: schema.project.id, key: schema.project.key, name: schema.project.name, teamId: schema.project.teamId })
        .from(schema.project)
        .where(and(eq(schema.project.id, projectId), eq(schema.project.organizationId, ctx.organizationId)));
      if (!project) throw new Error("Project not found");

      const [issueTypes, priorityLevels, members, epics, boards] = await Promise.all([
        tx
          .select({
            id: schema.issueType.id,
            name: schema.issueType.name,
            color: schema.issueType.color,
            hierarchyLevel: schema.issueType.hierarchyLevel,
            isSubtask: schema.issueType.isSubtask,
          })
          .from(schema.issueType)
          .where(eq(schema.issueType.projectId, projectId))
          .orderBy(asc(schema.issueType.order)),
        listPriorityLevels(tx, projectId),
        tx
          .select({ userId: schema.member.userId, name: schema.user.name, email: schema.user.email })
          .from(schema.member)
          .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
          .where(eq(schema.member.organizationId, ctx.organizationId)),
        listCandidateEpics(tx, projectId),
        tx.select({ id: schema.board.id }).from(schema.board).where(eq(schema.board.projectId, projectId)),
      ]);
      const boardIds = boards.map((b) => b.id);
      const sprints =
        boardIds.length > 0
          ? await tx
              .select({ id: schema.sprint.id, name: schema.sprint.name, state: schema.sprint.state, number: schema.sprint.number })
              .from(schema.sprint)
              .where(and(inArray(schema.sprint.boardId, boardIds), ne(schema.sprint.state, "closed")))
              .orderBy(asc(schema.sprint.number))
          : [];

      return {
        project,
        issueTypes,
        priorityLevels: [...priorityLevels].sort((a, b) => a.order - b.order),
        members: members.sort((a, b) => a.name.localeCompare(b.name)),
        epics,
        sprints,
        currentUserId: ctx.userId,
      };
    });
  });
