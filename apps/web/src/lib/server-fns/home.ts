import { createServerFn } from "@tanstack/react-start";
import { and, eq, ne, schema } from "@kompast/db";
import { getBoard, withAuthorizedTenant } from "@kompast/core";
import { requireAuthContext } from "../session";

export const getHomeSummaryFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();

  return withAuthorizedTenant(ctx, async (tx) => {
    const projects = await tx
      .select({ id: schema.project.id, key: schema.project.key, name: schema.project.name })
      .from(schema.project)
      .where(eq(schema.project.organizationId, ctx.organizationId));

    const firstProject = projects[0];
    let activeBoard: { name: string; columns: Awaited<ReturnType<typeof getBoard>>["columns"] } | null = null;
    if (firstProject) {
      const [board] = await tx.select().from(schema.board).where(eq(schema.board.projectId, firstProject.id));
      if (board) {
        const boardData = await getBoard(tx, board.id);
        activeBoard = { name: firstProject.name, columns: boardData.columns.slice(0, 4) };
      }
    }

    const myTasks = await tx
      .select({
        id: schema.issue.id,
        title: schema.issue.title,
        dueDate: schema.issue.dueDate,
        statusId: schema.issue.statusId,
      })
      .from(schema.issue)
      .innerJoin(schema.workflowStatus, eq(schema.workflowStatus.id, schema.issue.statusId))
      .where(
        and(
          eq(schema.issue.organizationId, ctx.organizationId),
          eq(schema.issue.assigneeId, ctx.userId),
          ne(schema.workflowStatus.category, "done"),
        ),
      )
      .limit(10);

    return { projects, activeBoard, myTasks };
  });
});
