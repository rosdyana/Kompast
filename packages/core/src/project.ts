import { schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

export interface CreateProjectInput {
  organizationId: string;
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
