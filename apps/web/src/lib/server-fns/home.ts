import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, inArray, isNull, ne, schema, sql } from "@kompast/db";
import { listTeamsForWorkspace, withAuthorizedTenant } from "@kompast/core";
import { requireAuthContext } from "../session";

/**
 * Read-only "For you" summary: my open issues, every project with its open
 * issue count and active-sprint progress, and one active sprint's status
 * breakdown. Archived issues are excluded everywhere.
 */
export const getHomeSummaryFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();

  return withAuthorizedTenant(ctx, async (tx) => {
    const projects = await tx
      .select({ id: schema.project.id, key: schema.project.key, name: schema.project.name, teamId: schema.project.teamId })
      .from(schema.project)
      .where(eq(schema.project.organizationId, ctx.organizationId))
      .orderBy(asc(schema.project.name));

    const myIssues = await tx
      .select({
        id: schema.issue.id,
        title: schema.issue.title,
        keySeq: schema.issue.keySeq,
        dueDate: schema.issue.dueDate,
        priority: schema.issue.priority,
        updatedAt: schema.issue.updatedAt,
        statusName: schema.workflowStatus.name,
        statusColor: schema.workflowStatus.color,
        statusCategory: schema.workflowStatus.category,
        typeName: schema.issueType.name,
        typeColor: schema.issueType.color,
        typeHierarchyLevel: schema.issueType.hierarchyLevel,
        typeIsSubtask: schema.issueType.isSubtask,
        projectKey: schema.project.key,
        projectName: schema.project.name,
        teamId: schema.project.teamId,
      })
      .from(schema.issue)
      .innerJoin(schema.workflowStatus, eq(schema.workflowStatus.id, schema.issue.statusId))
      .innerJoin(schema.issueType, eq(schema.issueType.id, schema.issue.typeId))
      .innerJoin(schema.project, eq(schema.project.id, schema.issue.projectId))
      .where(
        and(
          eq(schema.issue.organizationId, ctx.organizationId),
          eq(schema.issue.assigneeId, ctx.userId),
          ne(schema.workflowStatus.category, "done"),
          isNull(schema.issue.archivedAt),
        ),
      )
      .orderBy(sql`${schema.issue.dueDate} asc nulls last`, desc(schema.issue.updatedAt))
      .limit(25);

    const projectIds = projects.map((p) => p.id);

    const openCounts =
      projectIds.length > 0
        ? await tx
            .select({ projectId: schema.issue.projectId, n: sql<number>`count(*)::int` })
            .from(schema.issue)
            .innerJoin(schema.workflowStatus, eq(schema.workflowStatus.id, schema.issue.statusId))
            .where(and(inArray(schema.issue.projectId, projectIds), ne(schema.workflowStatus.category, "done"), isNull(schema.issue.archivedAt)))
            .groupBy(schema.issue.projectId)
        : [];

    const activeSprints =
      projectIds.length > 0
        ? await tx
            .select({
              id: schema.sprint.id,
              name: schema.sprint.name,
              startAt: schema.sprint.startAt,
              endAt: schema.sprint.endAt,
              projectId: schema.board.projectId,
            })
            .from(schema.sprint)
            .innerJoin(schema.board, eq(schema.board.id, schema.sprint.boardId))
            .where(and(inArray(schema.board.projectId, projectIds), eq(schema.sprint.state, "active")))
        : [];

    const sprintIds = activeSprints.map((s) => s.id);
    const sprintBreakdown =
      sprintIds.length > 0
        ? await tx
            .select({
              sprintId: schema.issue.sprintId,
              category: schema.workflowStatus.category,
              n: sql<number>`count(*)::int`,
              points: sql<number>`coalesce(sum(${schema.issue.storyPoints}), 0)::float`,
            })
            .from(schema.issue)
            .innerJoin(schema.workflowStatus, eq(schema.workflowStatus.id, schema.issue.statusId))
            .where(and(inArray(schema.issue.sprintId, sprintIds), isNull(schema.issue.archivedAt)))
            .groupBy(schema.issue.sprintId, schema.workflowStatus.category)
        : [];

    const sprintSummaries = activeSprints.map((s) => {
      const rows = sprintBreakdown.filter((r) => r.sprintId === s.id);
      const by = (c: "todo" | "in_progress" | "done") => rows.find((r) => r.category === c)?.n ?? 0;
      return {
        ...s,
        todo: by("todo"),
        inProgress: by("in_progress"),
        done: by("done"),
        total: rows.reduce((sum, r) => sum + r.n, 0),
        points: rows.reduce((sum, r) => sum + r.points, 0),
        donePoints: rows.find((r) => r.category === "done")?.points ?? 0,
      };
    });

    const [membership, teams] = await Promise.all([
      tx
        .select({ isSuperAdmin: schema.member.isSuperAdmin })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.userId, ctx.userId)))
        .then((rows) => rows[0]),
      listTeamsForWorkspace(tx, ctx),
    ]);

    return {
      projects: projects.map((p) => ({
        ...p,
        openIssueCount: openCounts.find((c) => c.projectId === p.id)?.n ?? 0,
        activeSprint: sprintSummaries.find((s) => s.projectId === p.id) ?? null,
      })),
      myIssues,
      isSuperAdmin: membership?.isSuperAdmin ?? false,
      adminTeamIds: teams.filter((t) => t.myRole === "admin").map((t) => t.id),
    };
  });
});
