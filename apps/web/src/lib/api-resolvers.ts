import { and, eq, schema } from "@kompast/db";
import { canAccessPage, getPage, type Tx, type PageRole } from "@kompast/core";
import { ApiError } from "./api-auth";

/**
 * Human-friendly lookups shared by REST and MCP — both speak project keys
 * (KPT), issue keys (KPT-123), and type/status names, never raw internal
 * ids, since an external caller (or an LLM) has no way to know those.
 *
 * The project/issue/status/user resolvers now live in packages/core (so the
 * Ask Kompast tools can share them). They throw core's NotFoundError /
 * ConflictError / InvalidInputError, which handleApiRoute and the MCP tool
 * wrapper map to the same 404 / 409 / 400 responses these used to produce.
 */
export { resolveProject, resolveIssue, resolveIssueType, resolveStatus, resolveUserByEmail, parseIssueKey } from "@kompast/core";

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

/** Every project has exactly one board (see packages/core/src/project.ts's seeding) — REST/MCP address sprints by projectKey, not raw boardId. */
export async function resolveBoardForProject(tx: Tx, projectId: string) {
  const [board] = await tx.select().from(schema.board).where(eq(schema.board.projectId, projectId));
  if (!board) throw new ApiError(404, "Not Found", "Project has no board");
  return board;
}

export async function resolveSprint(tx: Tx, organizationId: string, sprintId: string) {
  const [sprint] = await tx
    .select()
    .from(schema.sprint)
    .where(and(eq(schema.sprint.id, sprintId), eq(schema.sprint.organizationId, organizationId)));
  if (!sprint) throw new ApiError(404, "Not Found", `Sprint ${sprintId} not found`);
  return sprint;
}

export async function resolveImportRun(tx: Tx, organizationId: string, importRunId: string) {
  const [run] = await tx.select().from(schema.importRun).where(and(eq(schema.importRun.id, importRunId), eq(schema.importRun.organizationId, organizationId)));
  if (!run) throw new ApiError(404, "Not Found", `Import run ${importRunId} not found`);
  return run;
}
