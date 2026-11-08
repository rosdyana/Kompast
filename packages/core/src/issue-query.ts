import { and, arrayContains, asc, desc, eq, gt, isNull, schema, sql, type SQL } from "@kompast/db";
import type { Tx } from "./types";
import { ConflictError, InvalidInputError, NotFoundError } from "./errors";

/**
 * Human-friendly lookups shared by REST, MCP and the Ask Kompast tools — all
 * speak project keys (KPT), issue keys (KPT-123), and status names, never raw
 * internal ids, since an external caller (or an LLM) can't know those.
 * Moved here from apps/web/src/lib/api-resolvers.ts; the web module re-exports
 * them so existing REST/MCP imports keep working.
 */
export async function resolveProject(tx: Tx, organizationId: string, projectKey: string) {
  const matches = await tx
    .select()
    .from(schema.project)
    .where(and(eq(schema.project.organizationId, organizationId), eq(schema.project.key, projectKey.toUpperCase())));
  if (matches.length === 0) throw new NotFoundError(`Project ${projectKey} not found`);
  if (matches.length > 1) {
    throw new ConflictError(`Project key "${projectKey}" is ambiguous across teams — use the project id.`);
  }
  return matches[0]!;
}

const ISSUE_KEY_PATTERN = /^([a-zA-Z]+)-(\d+)$/;

export function parseIssueKey(issueKey: string) {
  const match = ISSUE_KEY_PATTERN.exec(issueKey.trim());
  if (!match) throw new InvalidInputError(`"${issueKey}" is not a valid issue key (expected e.g. KPT-123)`);
  return { projectKey: match[1]!, keySeq: Number(match[2]) };
}

export async function resolveIssue(tx: Tx, organizationId: string, issueKey: string) {
  const { projectKey, keySeq } = parseIssueKey(issueKey);
  const project = await resolveProject(tx, organizationId, projectKey);

  const [issue] = await tx
    .select()
    .from(schema.issue)
    .where(and(eq(schema.issue.projectId, project.id), eq(schema.issue.keySeq, keySeq)));
  if (!issue) throw new NotFoundError(`Issue ${issueKey} not found`);

  return { project, issue };
}

export async function resolveStatus(tx: Tx, projectId: string, name?: string) {
  const statuses = await tx
    .select()
    .from(schema.workflowStatus)
    .where(eq(schema.workflowStatus.projectId, projectId))
    .orderBy(asc(schema.workflowStatus.order));
  if (name) {
    const match = statuses.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!match) throw new InvalidInputError(`Status "${name}" not found in this project`);
    return match;
  }
  const fallback = statuses.find((s) => s.category === "todo") ?? statuses[0];
  if (!fallback) throw new Error("Project has no workflow statuses");
  return fallback;
}

export async function resolveUserByEmail(tx: Tx, organizationId: string, email: string) {
  const [row] = await tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .innerJoin(schema.member, eq(schema.member.userId, schema.user.id))
    .where(and(eq(schema.member.organizationId, organizationId), eq(schema.user.email, email.toLowerCase())));
  if (!row) throw new InvalidInputError(`No workspace member with email ${email}`);
  return row.id;
}

export interface QueryIssuesFilters {
  projectKey?: string;
  /** Workflow status name. With a projectKey it must exist in that project (else InvalidInputError); without one it matches any project's status of that name. */
  statusName?: string;
  assigneeId?: string;
  sprintId?: string;
  epicIssueId?: string;
  label?: string;
  includeArchived?: boolean;
  /** Only honored with a projectKey: keyset cursor on keySeq (issues with keySeq greater than this). */
  cursor?: number;
  /** Defaults to 25. */
  limit?: number;
}

export interface IssueQueryRow {
  issue: typeof schema.issue.$inferSelect;
  projectKey: string;
}

/**
 * One query behind both MCP list_issues and the Ask Kompast list_issues tool.
 *
 * With a projectKey: that project's issues, oldest key first, keyset-paged by
 * keySeq; nextCursor is the last keySeq when a full page came back. Without
 * one: issues across every project the caller can see (RLS scopes that), most
 * recently updated first, and the cursor is ignored (nextCursor is null) —
 * keySeq isn't unique across projects, so it can't page a cross-project list.
 *
 * Runs on the caller's transaction, so visibility is whatever RLS allows that
 * user. Name lookups throw the same NotFound/InvalidInput errors the REST and
 * MCP surfaces already map.
 */
export async function queryIssues(tx: Tx, organizationId: string, filters: QueryIssuesFilters): Promise<{ rows: IssueQueryRow[]; nextCursor: number | null }> {
  const limit = filters.limit ?? 25;
  const conditions: SQL[] = [];
  if (!filters.includeArchived) conditions.push(isNull(schema.issue.archivedAt));
  if (filters.assigneeId) conditions.push(eq(schema.issue.assigneeId, filters.assigneeId));
  if (filters.sprintId) conditions.push(eq(schema.issue.sprintId, filters.sprintId));
  if (filters.epicIssueId) conditions.push(eq(schema.issue.epicId, filters.epicIssueId));
  if (filters.label) conditions.push(arrayContains(schema.issue.labels, [filters.label]));

  if (filters.projectKey) {
    const project = await resolveProject(tx, organizationId, filters.projectKey);
    conditions.push(eq(schema.issue.projectId, project.id), gt(schema.issue.keySeq, filters.cursor ?? 0));
    if (filters.statusName) conditions.push(eq(schema.issue.statusId, (await resolveStatus(tx, project.id, filters.statusName)).id));

    const rows = await tx
      .select({ issue: schema.issue, projectKey: schema.project.key })
      .from(schema.issue)
      .innerJoin(schema.project, eq(schema.project.id, schema.issue.projectId))
      .where(and(...conditions))
      .orderBy(asc(schema.issue.keySeq))
      .limit(limit);
    const nextCursor = rows.length === limit ? rows[rows.length - 1]!.issue.keySeq : null;
    return { rows, nextCursor };
  }

  if (filters.statusName) {
    conditions.push(
      sql`${schema.issue.statusId} in (select ws.id from workflow_status ws where lower(ws.name) = lower(${filters.statusName}))`,
    );
  }
  conditions.push(eq(schema.project.organizationId, organizationId));
  const rows = await tx
    .select({ issue: schema.issue, projectKey: schema.project.key })
    .from(schema.issue)
    .innerJoin(schema.project, eq(schema.project.id, schema.issue.projectId))
    .where(and(...conditions))
    .orderBy(desc(schema.issue.updatedAt))
    .limit(limit);
  return { rows, nextCursor: null };
}
