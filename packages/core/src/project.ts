import { eq, schema, sql } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

export interface CreateProjectInput {
  organizationId: string;
  /**
   * Required for every project created through the app going forward
   * (packages/core's requireTeamAdmin gates the only caller that supplies
   * one, apps/web/src/lib/server-fns/projects.ts's createProjectFn). The DB
   * column itself stays nullable — existing null-teamId rows in any
   * already-running deployment are left alone, no forced backfill.
   */
  teamId: string;
  key: string;
  name: string;
  actorUserId: string;
  icon?: string;
}

const DEFAULT_ISSUE_TYPES = [
  { name: "Epic", icon: "◆", color: "var(--violet)", hierarchyLevel: 0, isSubtask: false },
  { name: "Story", icon: "◇", color: "var(--green)", hierarchyLevel: 1, isSubtask: false },
  { name: "Task", icon: "▪", color: "var(--indigo)", hierarchyLevel: 1, isSubtask: false },
  { name: "Bug", icon: "✕", color: "var(--accent)", hierarchyLevel: 1, isSubtask: false },
  { name: "Subtask", icon: "·", color: "var(--text3)", hierarchyLevel: 2, isSubtask: true },
] as const;

const DEFAULT_STATUSES = [
  { name: "Backlog", category: "todo", color: "var(--text3)" },
  { name: "To Do", category: "todo", color: "var(--indigo)" },
  { name: "In Progress", category: "in_progress", color: "var(--amber)" },
  { name: "In Review", category: "in_progress", color: "var(--violet)" },
  { name: "Done", category: "done", color: "var(--green)" },
] as const;

/**
 * Seeds a new project with JIRA-shaped defaults: issue types, a linear
 * workflow, one kanban board whose columns map 1:1 onto that workflow's
 * statuses, and the creator as project lead. Everything below runs inside
 * the caller's transaction (see permissions.ts `withAuthorizedTenant`) so a
 * failure partway through leaves nothing behind.
 */
export async function createProject(tx: Tx, input: CreateProjectInput) {
  const projectId = id("proj");

  await tx.insert(schema.project).values({
    id: projectId,
    organizationId: input.organizationId,
    teamId: input.teamId,
    key: input.key.toUpperCase(),
    name: input.name,
    icon: input.icon,
    leadId: input.actorUserId,
  });

  await tx.insert(schema.projectMember).values({
    id: id("pmem"),
    projectId,
    userId: input.actorUserId,
    role: "lead",
  });

  const issueTypeRows = DEFAULT_ISSUE_TYPES.map((t) => ({
    id: id("itype"),
    projectId,
    name: t.name,
    icon: t.icon,
    color: t.color,
    hierarchyLevel: t.hierarchyLevel,
    isSubtask: t.isSubtask,
  }));
  await tx.insert(schema.issueType).values(issueTypeRows);

  const statusRows = DEFAULT_STATUSES.map((s, order) => ({
    id: id("status"),
    projectId,
    name: s.name,
    category: s.category,
    color: s.color,
    order,
  }));
  await tx.insert(schema.workflowStatus).values(statusRows);

  const boardId = id("board");
  await tx.insert(schema.board).values({
    id: boardId,
    projectId,
    name: "Board utama",
    type: "kanban",
  });

  for (const [index, status] of statusRows.entries()) {
    const columnId = id("col");
    await tx.insert(schema.boardColumn).values({
      id: columnId,
      boardId,
      name: status.name,
      color: status.color,
      order: index,
      isBacklog: index === 0,
    });
    await tx.insert(schema.boardColumnStatus).values({
      id: id("colstatus"),
      boardColumnId: columnId,
      workflowStatusId: status.id,
    });
  }

  return { projectId, boardId, issueTypes: issueTypeRows, statuses: statusRows };
}

export interface CreateWorkflowStatusInput {
  projectId: string;
  /** The board a matching column is created on, so the new status is immediately visible on some board rather than only queryable. One column per status, never grouped — grouping multiple statuses into one column is a manual UI action, not something a caller here decides on the status's behalf. */
  boardId: string;
  name: string;
  category: "todo" | "in_progress" | "done";
  color?: string;
}

/**
 * Adds a single status to an already-existing project — createProject's
 * DEFAULT_STATUSES only covers a project's initial seed. Needed by the
 * importer (packages/import) when a source status (e.g. a JIRA workflow
 * step) doesn't match anything the target project already has.
 */
export async function createWorkflowStatus(tx: Tx, input: CreateWorkflowStatusInput) {
  const [row] = await tx
    .select({ nextOrder: sql<number>`coalesce(max(${schema.workflowStatus.order}), -1) + 1` })
    .from(schema.workflowStatus)
    .where(eq(schema.workflowStatus.projectId, input.projectId));
  const nextOrder = row!.nextOrder;

  const statusId = id("status");
  await tx.insert(schema.workflowStatus).values({
    id: statusId,
    projectId: input.projectId,
    name: input.name,
    category: input.category,
    color: input.color ?? "var(--text3)",
    order: nextOrder,
  });

  const [colRow] = await tx
    .select({ nextColumnOrder: sql<number>`coalesce(max(${schema.boardColumn.order}), -1) + 1` })
    .from(schema.boardColumn)
    .where(eq(schema.boardColumn.boardId, input.boardId));
  const nextColumnOrder = colRow!.nextColumnOrder;

  const columnId = id("col");
  await tx.insert(schema.boardColumn).values({
    id: columnId,
    boardId: input.boardId,
    name: input.name,
    color: input.color ?? "var(--text3)",
    order: nextColumnOrder,
  });
  await tx.insert(schema.boardColumnStatus).values({ id: id("colstatus"), boardColumnId: columnId, workflowStatusId: statusId });

  return { statusId };
}

export interface CreateIssueTypeInput {
  projectId: string;
  name: string;
  icon?: string;
  color?: string;
  hierarchyLevel?: number;
  isSubtask?: boolean;
}

/** Same idea as createWorkflowStatus, for issue types — needed when a source issue type (e.g. JIRA's "Improvement") doesn't match anything the target project already has. */
export async function createIssueType(tx: Tx, input: CreateIssueTypeInput) {
  const typeId = id("itype");
  await tx.insert(schema.issueType).values({
    id: typeId,
    projectId: input.projectId,
    name: input.name,
    icon: input.icon ?? "▪",
    color: input.color ?? "var(--text3)",
    hierarchyLevel: input.hierarchyLevel ?? 1,
    isSubtask: input.isSubtask ?? false,
  });
  return { typeId };
}
