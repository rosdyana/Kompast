import { and, asc, eq, schema } from "@kompast/db";
import { canAccessPage, getPage, type Tx, type PageRole } from "@kompast/core";
import { ApiError } from "./api-auth";

/**
 * Human-friendly lookups shared by REST and MCP — both speak project keys
 * (KPT), issue keys (KPT-123), and type/status names, never raw internal
 * ids, since an external caller (or an LLM) has no way to know those.
 */
export async function resolveProject(tx: Tx, organizationId: string, projectKey: string) {
  const [project] = await tx
    .select()
    .from(schema.project)
    .where(and(eq(schema.project.organizationId, organizationId), eq(schema.project.key, projectKey.toUpperCase())));
  if (!project) throw new ApiError(404, "Not Found", `Project ${projectKey} not found`);
  return project;
}

const ISSUE_KEY_PATTERN = /^([a-zA-Z]+)-(\d+)$/;

export function parseIssueKey(issueKey: string) {
  const match = ISSUE_KEY_PATTERN.exec(issueKey.trim());
  if (!match) throw new ApiError(400, "Bad Request", `"${issueKey}" is not a valid issue key (expected e.g. KPT-123)`);
  return { projectKey: match[1]!, keySeq: Number(match[2]) };
}

export async function resolveIssue(tx: Tx, organizationId: string, issueKey: string) {
  const { projectKey, keySeq } = parseIssueKey(issueKey);
  const project = await resolveProject(tx, organizationId, projectKey);

  const [issue] = await tx
    .select()
    .from(schema.issue)
    .where(and(eq(schema.issue.projectId, project.id), eq(schema.issue.keySeq, keySeq)));
  if (!issue) throw new ApiError(404, "Not Found", `Issue ${issueKey} not found`);

  return { project, issue };
}

export async function resolveIssueType(tx: Tx, projectId: string, name?: string) {
  const types = await tx.select().from(schema.issueType).where(eq(schema.issueType.projectId, projectId));
  if (name) {
    const match = types.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!match) throw new ApiError(400, "Bad Request", `Issue type "${name}" not found in this project`);
    return match;
  }
  const fallback = types.find((t) => !t.isSubtask) ?? types[0];
  if (!fallback) throw new ApiError(500, "Internal Server Error", "Project has no issue types");
  return fallback;
}

export async function resolveStatus(tx: Tx, projectId: string, name?: string) {
  const statuses = await tx
    .select()
    .from(schema.workflowStatus)
    .where(eq(schema.workflowStatus.projectId, projectId))
    .orderBy(asc(schema.workflowStatus.order));
  if (name) {
    const match = statuses.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!match) throw new ApiError(400, "Bad Request", `Status "${name}" not found in this project`);
    return match;
  }
  const fallback = statuses.find((s) => s.category === "todo") ?? statuses[0];
  if (!fallback) throw new ApiError(500, "Internal Server Error", "Project has no workflow statuses");
  return fallback;
}

/** REST/MCP respects page_permission the same as the UI — a caller's own membership isn't enough if the page is restricted. */
export async function resolvePage(
  tx: Tx,
  ctx: { userId: string; organizationId: string },
  pageId: string,
  minRole: PageRole = "view",
) {
  const page = await getPage(tx, pageId).catch(() => null);
  if (!page) throw new ApiError(404, "Not Found", `Page ${pageId} not found`);

  const allowed = await canAccessPage(tx, pageId, ctx, minRole);
  if (!allowed) throw new ApiError(404, "Not Found", `Page ${pageId} not found`);

  return page;
}

export async function resolveUserByEmail(tx: Tx, organizationId: string, email: string) {
  const [row] = await tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .innerJoin(schema.member, eq(schema.member.userId, schema.user.id))
    .where(and(eq(schema.member.organizationId, organizationId), eq(schema.user.email, email.toLowerCase())));
  if (!row) throw new ApiError(400, "Bad Request", `No workspace member with email ${email}`);
  return row.id;
}
