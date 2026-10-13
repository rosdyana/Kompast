import * as z from "zod";
import * as Y from "yjs";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, arrayContains, asc, eq, gt, ilike, inArray, isNull, schema, type Json } from "@kompast/db";
import {
  createIssue,
  updateIssue,
  updateIssueCustomField,
  moveIssue,
  archiveIssue,
  restoreIssue,
  addComment,
  listComments,
  toPlainText,
  linkIssues,
  listIssueLinks,
  logWork,
  listWorklogs,
  setWatching,
  listWatchers,
  listAttachments,
  listChecklistItems,
  addChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
  moveChecklistItem,
  listIssuePropertyDefinitions,
  listPriorityLevels,
  listCandidateEpics,
  listAssignableUsers,
  listTeamsForWorkspace,
  requireProjectAdmin,
  createPage,
  getPage,
  updatePageMeta,
  movePage,
  archivePage,
  restorePage,
  duplicatePage,
  listArchivedPages,
  permanentlyDeletePage,
  listTemplatePages,
  listPageVersions,
  getPageVersionSnapshot,
  toggleFavoritePage,
  listFavoritePageIds,
  addPageComment,
  listPageComments,
  resolvePageComment,
  linkEntities,
  unlinkEntities,
  listOutgoingLinks,
  listBacklinks,
  listPageTree,
  filterAccessiblePages,
  searchWorkspace,
  withAuthorizedTenant,
  withIdempotency,
  ForbiddenError,
  AutomationGraphError,
  PageSpaceError,
  listSprints,
  createSprint,
  updateSprint,
  listBacklogIssues,
  listSprintIssues,
  addIssueToSprint,
  removeIssueFromSprint,
  getSprintReport,
  getBurndown,
  getCumulativeFlow,
  getVelocityHistory,
  startSprint,
  completeSprint,
  getEpicRoadmap,
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  listWorkflowRuns,
  getWorkflowRun,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  requireTeamMember,
  canAccessPage,
  canManagePageAccess,
  getPageAccess,
  grantPageAccess,
  removePagePermission,
  type Tx,
} from "@kompast/core";
import type { ApiAuthContext } from "@/lib/api-auth";
import { ApiError } from "@/lib/api-auth";
import {
  resolveProject,
  resolveIssue,
  resolveIssueType,
  resolveStatus,
  resolveUserByEmail,
  resolvePage,
  resolveBoardForProject,
  resolveSprint,
} from "@/lib/api-resolvers";
import { createServerSchema } from "@/lib/blocknote-schema";
import { seedPageContentFromMarkdown } from "./seed-page-content";

function hasScope(ctx: ApiAuthContext, scope: string): boolean {
  const [resource, action] = scope.split(":");
  return !!(resource && action && ctx.scopes[resource]?.includes(action));
}

function toolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * Every tool call goes through this: a missing scope is a tool-level error
 * (isError: true), not an HTTP 403 — one /mcp POST is one JSON-RPC call, so
 * there's no earlier point to reject a specific tool's scope requirement.
 * Unlike REST's deliberately-vague "wrong scope looks like unknown key"
 * (see api-auth.ts), here the caller already authenticated successfully;
 * naming the missing scope back to them leaks nothing new.
 */
function tool(ctx: ApiAuthContext, scope: string | null, fn: () => Promise<unknown>) {
  return async () => {
    if (scope && !hasScope(ctx, scope)) return toolError(`Missing required token scope: ${scope}`);
    try {
      return toolResult(await fn());
    } catch (err) {
      if (err instanceof ApiError) return toolError(err.detail);
      if (err instanceof ForbiddenError) return toolError(err.message);
      // Client input errors, same mapping as REST's handleApiRoute (400s there).
      if (err instanceof AutomationGraphError || err instanceof PageSpaceError) return toolError(err.message);
      console.error("[mcp] tool error:", err);
      return toolError("Internal error");
    }
  };
}

function serializeIssue(issue: typeof schema.issue.$inferSelect, projectKey: string) {
  return {
    key: `${projectKey}-${issue.keySeq}`,
    id: issue.id,
    title: issue.title,
    typeId: issue.typeId,
    statusId: issue.statusId,
    priority: issue.priority,
    assigneeId: issue.assigneeId,
    reporterId: issue.reporterId,
    storyPoints: issue.storyPoints,
    dueDate: issue.dueDate,
    labels: issue.labels,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function serializePage(page: typeof schema.page.$inferSelect) {
  return {
    id: page.id,
    title: page.title,
    icon: page.icon,
    parentPageId: page.parentPageId,
    projectId: page.projectId,
    teamId: page.teamId,
    /** In the caller's own Private space. Only ever true for the caller's pages: RLS hides everyone else's. */
    private: page.privateOwnerId !== null,
    /** A private page its owner has invited specific people into (Notion's "Shared"). */
    shared: page.sharedWith.length > 0,
    type: page.type,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
  };
}

function yjsStateToMarkdown(state: Uint8Array): Promise<string> {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, state);
  const editor = ServerBlockNoteEditor.create({ schema: createServerSchema() as any });
  const blocks = editor.yDocToBlocks(ydoc, "document-store");
  return editor.blocksToMarkdownLossy(blocks);
}

async function renderPageMarkdown(tx: Tx, pageId: string): Promise<string> {
  const [state] = await tx.select().from(schema.ydocState).where(eq(schema.ydocState.pageId, pageId));
  if (!state) return "";
  return yjsStateToMarkdown(state.state);
}

/** Plain text in, a one-paragraph BlockNote document out — the shape issue descriptions and comments are stored in. */
function paragraphDoc(text: string) {
  return [{ type: "paragraph", content: [{ type: "text", text, styles: {} }] }];
}

function toDate(value: string | null | undefined): Date | null | undefined {
  return value === undefined ? undefined : value === null ? null : new Date(value);
}

/** Issue keys for a batch of issue ids — what an MCP caller can use in a follow-up call, unlike a raw id. */
async function issueKeysById(tx: Tx, issueIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(issueIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: schema.issue.id, keySeq: schema.issue.keySeq, projectKey: schema.project.key })
    .from(schema.issue)
    .innerJoin(schema.project, eq(schema.project.id, schema.issue.projectId))
    .where(inArray(schema.issue.id, ids));
  return new Map(rows.map((r) => [r.id, `${r.projectKey}-${r.keySeq}`]));
}

/** Soft delete/restore is gated to the project's admin/lead, same as the issue page's Archive button. */
async function requireIssueAdmin(tx: Tx, ctx: ApiAuthContext, projectId: string) {
  await requireProjectAdmin(tx, { userId: ctx.userId, organizationId: ctx.organizationId, projectId });
}

/**
 * Builds a fresh McpServer for a single authenticated request. Kompast's
 * /mcp is deliberately stateless (see plan §"REST API + MCP") — no session
 * persists between HTTP requests, so there's no shared registry to keep in
 * sync; every tool closes over this one request's ctx and reuses exactly
 * the same packages/core calls REST does, which is what keeps the two
 * surfaces' authorization from drifting apart.
 */
export function buildMcpServer(ctx: ApiAuthContext) {
  const server = new McpServer({ name: "kompast", version: "1.0.0" });

  server.registerTool(
    "whoami",
    { description: "Identify the authenticated user and token scopes." },
    tool(ctx, null, async () => ({ userId: ctx.userId, organizationId: ctx.organizationId, scopes: ctx.scopes, origin: ctx.origin })),
  );

  server.registerTool(
    "search",
    {
      description: "Unified search across issues and workspace members.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().positive().max(50).optional() },
    },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, (tx) => searchWorkspace(tx, ctx.organizationId, args.query, args.limit)),
      )(),
  );

  server.registerTool(
    "list_projects",
    { description: "List projects in the workspace." },
    tool(ctx, "issues:read", () =>
      withAuthorizedTenant(ctx, (tx) =>
        tx
          .select({ id: schema.project.id, key: schema.project.key, name: schema.project.name })
          .from(schema.project)
          .where(and(eq(schema.project.organizationId, ctx.organizationId), isNull(schema.project.archivedAt))),
      ),
    ),
  );

  server.registerTool(
    "list_boards",
    {
      description: "List boards for a project.",
      inputSchema: { projectKey: z.string().min(1) },
    },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const project = await resolveProject(tx, ctx.organizationId, args.projectKey);
          return tx.select({ id: schema.board.id, name: schema.board.name }).from(schema.board).where(eq(schema.board.projectId, project.id));
        }),
      )(),
  );

  server.registerTool(
    "get_roadmap",
    { description: "List epics for a project with their date range and child-issue completion.", inputSchema: { projectKey: z.string().min(1) } },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const project = await resolveProject(tx, ctx.organizationId, args.projectKey);
          const epics = await getEpicRoadmap(tx, project.id);
          return epics.map((e) => ({
            key: `${project.key}-${e.keySeq}`,
            title: e.title,
            startDate: e.startDate,
            dueDate: e.dueDate,
            childCount: e.childCount,
            doneCount: e.doneCount,
          }));
        }),
      )(),
  );

  server.registerTool(
    "list_issues",
    {
      description: "List issues in a project, oldest key first. Archived issues are left out unless includeArchived is set.",
      inputSchema: {
        projectKey: z.string().min(1),
        status: z.string().optional().describe("Workflow status name, e.g. \"In Progress\"."),
        assigneeEmail: z.email().optional(),
        sprintId: z.string().optional(),
        epicKey: z.string().optional(),
        label: z.string().optional(),
        includeArchived: z.boolean().optional(),
        cursor: z.number().int().optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const project = await resolveProject(tx, ctx.organizationId, args.projectKey);
          const limit = args.limit ?? 25;
          const conditions = [eq(schema.issue.projectId, project.id), gt(schema.issue.keySeq, args.cursor ?? 0)];
          if (!args.includeArchived) conditions.push(isNull(schema.issue.archivedAt));
          if (args.status) conditions.push(eq(schema.issue.statusId, (await resolveStatus(tx, project.id, args.status)).id));
          if (args.assigneeEmail) conditions.push(eq(schema.issue.assigneeId, await resolveUserByEmail(tx, ctx.organizationId, args.assigneeEmail)));
          if (args.sprintId) conditions.push(eq(schema.issue.sprintId, args.sprintId));
          if (args.epicKey) conditions.push(eq(schema.issue.epicId, (await resolveIssue(tx, ctx.organizationId, args.epicKey)).issue.id));
          if (args.label) conditions.push(arrayContains(schema.issue.labels, [args.label]));
          const rows = await tx
            .select()
            .from(schema.issue)
            .where(and(...conditions))
            .orderBy(asc(schema.issue.keySeq))
            .limit(limit);
          const nextCursor = rows.length === limit ? rows[rows.length - 1]!.keySeq : null;
          return { data: rows.map((r) => serializeIssue(r, project.key)), nextCursor };
        }),
      )(),
  );

  server.registerTool(
    "get_issue",
    {
      description:
        "Get a single issue by its key (e.g. KPT-42): fields, type/status names, description as plain text, epic/parent/sprint, checklist, and links to other issues and docs. Comments are separate (list_issue_comments).",
      inputSchema: { issueKey: z.string().min(1) },
    },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { project, issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          const [[type], [status], checklist, issueLinks, docLinks, watchers] = await Promise.all([
            tx.select({ name: schema.issueType.name }).from(schema.issueType).where(eq(schema.issueType.id, issue.typeId)),
            tx.select({ name: schema.workflowStatus.name, category: schema.workflowStatus.category }).from(schema.workflowStatus).where(eq(schema.workflowStatus.id, issue.statusId)),
            listChecklistItems(tx, issue.id),
            listIssueLinks(tx, issue.id),
            listBacklinks(tx, "issue", issue.id),
            listWatchers(tx, issue.id),
          ]);
          const keys = await issueKeysById(tx, [
            ...[issue.epicId, issue.parentId].filter((v): v is string => !!v),
            ...issueLinks.flatMap((l) => [l.fromIssueId, l.toIssueId]),
          ]);
          const linkedPageIds = docLinks.filter((l) => l.fromType === "page").map((l) => l.fromId);
          const linkedPages = linkedPageIds.length
            ? await filterAccessiblePages(tx, await tx.select().from(schema.page).where(and(inArray(schema.page.id, linkedPageIds), isNull(schema.page.archivedAt))), ctx)
            : [];
          return {
            ...serializeIssue(issue, project.key),
            type: type?.name ?? null,
            status: status?.name ?? null,
            statusCategory: status?.category ?? null,
            description: toPlainText(issue.descriptionJson),
            epicKey: issue.epicId ? keys.get(issue.epicId) ?? null : null,
            parentKey: issue.parentId ? keys.get(issue.parentId) ?? null : null,
            sprintId: issue.sprintId,
            startDate: issue.startDate,
            estimateSeconds: issue.estimateSeconds,
            spentSeconds: issue.spentSeconds,
            customFields: issue.customFields,
            archived: issue.archivedAt !== null,
            checklist: checklist.map((c) => ({ id: c.id, text: c.text, done: c.done })),
            issueLinks: issueLinks.map((l) => ({
              id: l.id,
              type: l.type,
              direction: l.fromIssueId === issue.id ? "outward" : "inward",
              issueKey: keys.get(l.fromIssueId === issue.id ? l.toIssueId : l.fromIssueId) ?? null,
            })),
            linkedPages: linkedPages.map((p) => ({ id: p.id, title: p.title })),
            watcherIds: watchers.map((w) => w.userId),
          };
        }),
      )(),
  );

  server.registerTool(
    "create_issue",
    {
      description: "Create an issue. Pass idempotencyKey to safely retry on timeout.",
      inputSchema: {
        projectKey: z.string().min(1),
        title: z.string().min(1),
        type: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().min(1).optional(),
        assigneeEmail: z.email().optional(),
        description: z.string().optional(),
        labels: z.array(z.string()).optional(),
        storyPoints: z.number().optional(),
        dueDate: z.string().optional(),
        epicKey: z.string().optional().describe("Epic to file the issue under, e.g. KPT-12."),
        parentKey: z.string().optional().describe("Parent issue, for a subtask."),
        sprintId: z.string().optional().describe("Sprint to add the issue to right away (see list_sprints)."),
        idempotencyKey: z.string().optional(),
      },
    },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const project = await resolveProject(tx, ctx.organizationId, args.projectKey);
          const run = async () => {
            const [type, status, assigneeId] = await Promise.all([
              resolveIssueType(tx, project.id, args.type),
              resolveStatus(tx, project.id, args.status),
              args.assigneeEmail ? resolveUserByEmail(tx, ctx.organizationId, args.assigneeEmail) : Promise.resolve(undefined),
            ]);
            const parentId = args.parentKey ? (await resolveIssue(tx, ctx.organizationId, args.parentKey)).issue.id : undefined;
            const epicId = args.epicKey ? (await resolveIssue(tx, ctx.organizationId, args.epicKey)).issue.id : undefined;
            if (args.sprintId) await resolveSprint(tx, ctx.organizationId, args.sprintId);
            const created = await createIssue(tx, {
              organizationId: ctx.organizationId,
              projectId: project.id,
              typeId: type.id,
              statusId: status.id,
              title: args.title,
              reporterId: ctx.userId,
              assigneeId,
              priority: args.priority,
              descriptionJson: args.description ? paragraphDoc(args.description) : undefined,
              labels: args.labels,
              storyPoints: args.storyPoints,
              dueDate: args.dueDate ? new Date(args.dueDate) : undefined,
              parentId,
              origin: ctx.origin,
              originClient: "mcp",
            });
            // Same follow-up steps, in the same transaction, as the UI's create dialog (createIssueFn).
            if (epicId) await updateIssue(tx, created.issueId, { epicId, actorId: ctx.userId, origin: ctx.origin, originClient: "mcp" });
            if (args.sprintId) await addIssueToSprint(tx, args.sprintId, created.issueId, { actorId: ctx.userId, origin: ctx.origin, originClient: "mcp" });
            return { key: `${project.key}-${created.keySeq}`, id: created.issueId };
          };
          if (!args.idempotencyKey) return run();
          const { response } = await withIdempotency(tx, ctx.organizationId, "create_issue", args.idempotencyKey, run);
          return response;
        }),
      )(),
  );

  server.registerTool(
    "update_issue",
    {
      description: "Update an issue's fields (partial). Does not change status — use transition_issue.",
      inputSchema: {
        issueKey: z.string().min(1),
        title: z.string().optional(),
        priority: z.string().min(1).optional(),
        storyPoints: z.number().nullable().optional(),
        dueDate: z.string().nullable().optional(),
        startDate: z.string().nullable().optional(),
        epicKey: z.string().nullable().optional(),
        parentKey: z.string().nullable().optional(),
        type: z.string().optional().describe("Issue type name, e.g. \"Bug\"."),
        estimateSeconds: z.number().int().nonnegative().nullable().optional(),
        labels: z.array(z.string()).optional(),
        description: z.string().optional().describe("Replaces the whole description with this plain text."),
      },
    },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { project, issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          const keyToId = async (key: string | null | undefined) =>
            key === undefined ? undefined : key === null ? null : (await resolveIssue(tx, ctx.organizationId, key)).issue.id;
          await updateIssue(tx, issue.id, {
            title: args.title,
            priority: args.priority,
            storyPoints: args.storyPoints,
            dueDate: toDate(args.dueDate),
            startDate: toDate(args.startDate),
            epicId: await keyToId(args.epicKey),
            parentId: await keyToId(args.parentKey),
            typeId: args.type ? (await resolveIssueType(tx, project.id, args.type)).id : undefined,
            estimateSeconds: args.estimateSeconds,
            labels: args.labels,
            descriptionJson: args.description !== undefined ? paragraphDoc(args.description) : undefined,
            actorId: ctx.userId,
            origin: ctx.origin,
            originClient: "mcp",
          });
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "transition_issue",
    {
      description: "Move an issue to a different workflow status by name (e.g. \"In Progress\", \"Done\").",
      inputSchema: { issueKey: z.string().min(1), status: z.string().min(1) },
    },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { project, issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          const status = await resolveStatus(tx, project.id, args.status);
          await moveIssue(tx, { issueId: issue.id, toStatusId: status.id, actorId: ctx.userId, origin: ctx.origin, originClient: "mcp" });
          return { ok: true, status: status.name };
        }),
      )(),
  );

  server.registerTool(
    "assign_issue",
    {
      description: "Assign (or unassign, by omitting assigneeEmail) an issue.",
      inputSchema: { issueKey: z.string().min(1), assigneeEmail: z.email().nullable().optional() },
    },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          const assigneeId =
            args.assigneeEmail == null ? null : await resolveUserByEmail(tx, ctx.organizationId, args.assigneeEmail);
          await updateIssue(tx, issue.id, { assigneeId, actorId: ctx.userId, origin: ctx.origin, originClient: "mcp" });
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "comment_issue",
    {
      description: "Add a comment to an issue, optionally as a reply to an existing comment (parentCommentId) — up to 3 levels deep.",
      inputSchema: { issueKey: z.string().min(1), text: z.string().min(1), parentCommentId: z.string().optional() },
    },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          const result = await addComment(tx, {
            issueId: issue.id,
            authorId: ctx.userId,
            bodyJson: paragraphDoc(args.text),
            parentCommentId: args.parentCommentId,
            origin: ctx.origin,
            originClient: "mcp",
          });
          return { id: result.commentId };
        }),
      )(),
  );

  server.registerTool(
    "link_issue",
    {
      description: "Link an issue to a doc page.",
      inputSchema: { issueKey: z.string().min(1), pageId: z.string().min(1) },
    },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          await resolvePage(tx, ctx, args.pageId, "edit");
          await linkEntities(tx, { organizationId: ctx.organizationId, fromType: "page", fromId: args.pageId, toType: "issue", toId: issue.id, createdBy: ctx.userId });
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "list_pages",
    {
      description: "List doc pages, optionally scoped to a project.",
      inputSchema: { projectKey: z.string().optional() },
    },
    (args) =>
      tool(ctx, "pages:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const projectId = args.projectKey ? (await resolveProject(tx, ctx.organizationId, args.projectKey)).id : null;
          const pages =
            args.projectKey !== undefined
              ? await tx.select().from(schema.page).where(and(eq(schema.page.organizationId, ctx.organizationId), isNull(schema.page.archivedAt), eq(schema.page.projectId, projectId!)))
              : await listPageTree(tx, ctx.organizationId, null);
          const visible = await filterAccessiblePages(tx, pages, ctx);
          return { data: visible.map(serializePage) };
        }),
      )(),
  );

  server.registerTool(
    "get_page",
    { description: "Get a page's metadata and content, rendered as Markdown.", inputSchema: { pageId: z.string().min(1) } },
    (args) =>
      tool(ctx, "pages:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const page = await resolvePage(tx, ctx, args.pageId, "view");
          const content = await renderPageMarkdown(tx, page.id);
          return { ...serializePage(page), content };
        }),
      )(),
  );

  server.registerTool(
    "create_page",
    {
      description: "Create a doc page. content (Markdown) is only honored on create — see update_page.",
      inputSchema: {
        title: z.string().min(1),
        projectKey: z.string().optional(),
        teamId: z.string().optional().describe("Team space (a team's own docs). Omit both this and projectKey for the shared Workspace space."),
        private: z.boolean().optional().describe("Put the page in the caller's own Private space, visible to them alone. Mutually exclusive with projectKey/teamId."),
        parentPageId: z.string().nullable().optional(),
        content: z.string().optional(),
        idempotencyKey: z.string().optional(),
      },
    },
    (args) =>
      tool(ctx, "pages:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const run = async () => {
            // undefined (not null) when unspecified — see the same note in routes/api/v1/pages.tsx.
            const projectId = args.projectKey ? (await resolveProject(tx, ctx.organizationId, args.projectKey)).id : undefined;
            if (args.teamId) await requireTeamMember(tx, { ...ctx, teamId: args.teamId });
            const page = await createPage(tx, {
              organizationId: ctx.organizationId,
              title: args.title,
              parentPageId: args.parentPageId,
              projectId,
              teamId: args.teamId,
              privateOwnerId: args.private ? ctx.userId : undefined,
              actorUserId: ctx.userId,
            });
            // Safe only because this page is brand new — see seed-page-content.ts for the full explanation.
            if (args.content) {
              await seedPageContentFromMarkdown(tx, page.id, args.content);
            }
            return serializePage(page);
          };
          if (!args.idempotencyKey) return run();
          const { response } = await withIdempotency(tx, ctx.organizationId, "create_page", args.idempotencyKey, run);
          return response;
        }),
      )(),
  );

  server.registerTool(
    "update_page",
    {
      description: "Update a page's title/icon. Content is not replaceable via this tool — it would race a live collab session.",
      inputSchema: { pageId: z.string().min(1), title: z.string().optional(), icon: z.string().nullable().optional() },
    },
    (args) =>
      tool(ctx, "pages:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          await resolvePage(tx, ctx, args.pageId, "edit");
          await updatePageMeta(tx, args.pageId, { title: args.title, icon: args.icon });
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "comment_page",
    { description: "Add a comment to a page.", inputSchema: { pageId: z.string().min(1), text: z.string().min(1) } },
    (args) =>
      tool(ctx, "pages:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          await resolvePage(tx, ctx, args.pageId, "comment");
          const result = await addPageComment(tx, { pageId: args.pageId, blockId: "page", authorId: ctx.userId, bodyJson: { text: args.text } });
          return { id: result.commentId };
        }),
      )(),
  );

  server.registerTool(
    "link_page_to_issue",
    { description: "Link a doc page to an issue.", inputSchema: { pageId: z.string().min(1), issueKey: z.string().min(1) } },
    (args) =>
      tool(ctx, "pages:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          await resolvePage(tx, ctx, args.pageId, "edit");
          const { issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          await linkEntities(tx, { organizationId: ctx.organizationId, fromType: "page", fromId: args.pageId, toType: "issue", toId: issue.id, createdBy: ctx.userId });
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "get_page_access",
    {
      description: "List who can open a page. An empty grants list means it's open to everyone who can see the page's space (workspace, team, or project).",
      inputSchema: { pageId: z.string().min(1) },
    },
    (args) =>
      tool(ctx, "pages:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          await resolvePage(tx, ctx, args.pageId, "view");
          const { grants } = await getPageAccess(tx, args.pageId, ctx);
          return { restricted: grants.length > 0, grants };
        }),
      )(),
  );

  server.registerTool(
    "set_page_access",
    {
      description:
        "Grant (role: view/comment/edit/full) or revoke (role: null) a user's or team's access to a page. The first grant restricts an open page to its access list; the caller is kept on it with full access.",
      inputSchema: {
        pageId: z.string().min(1),
        subjectType: z.enum(["user", "team"]),
        subjectId: z.string().min(1),
        role: z.enum(["view", "comment", "edit", "full"]).nullable(),
      },
    },
    (args) =>
      tool(ctx, "pages:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          await resolvePage(tx, ctx, args.pageId, "view");
          if (!(await canManagePageAccess(tx, args.pageId, ctx))) throw new ForbiddenError("You can't change who has access to this page");
          const subject = { type: args.subjectType, id: args.subjectId };
          if (args.role === null) await removePagePermission(tx, args.pageId, subject, ctx.userId);
          else await grantPageAccess(tx, { pageId: args.pageId, subject, role: args.role, actorUserId: ctx.userId });
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "list_sprints",
    { description: "List sprints for a project's board.", inputSchema: { projectKey: z.string().min(1) } },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const project = await resolveProject(tx, ctx.organizationId, args.projectKey);
          const board = await resolveBoardForProject(tx, project.id);
          const sprints = await listSprints(tx, board.id);
          return sprints.map((s) => ({ id: s.id, name: s.name, state: s.state, cycle: s.cycle }));
        }),
      )(),
  );

  server.registerTool(
    "get_sprint",
    { description: "Get a sprint's state and live scope/completion report.", inputSchema: { sprintId: z.string().min(1) } },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const sprint = await resolveSprint(tx, ctx.organizationId, args.sprintId);
          const report = await getSprintReport(tx, sprint.id);
          return { id: sprint.id, name: sprint.name, state: sprint.state, cycle: sprint.cycle, report };
        }),
      )(),
  );

  server.registerTool(
    "start_sprint",
    { description: "Start a sprint (fails if the board already has one active).", inputSchema: { sprintId: z.string().min(1) } },
    (args) =>
      tool(ctx, "sprints:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const sprint = await resolveSprint(tx, ctx.organizationId, args.sprintId);
          await startSprint(tx, { sprintId: sprint.id, actorId: ctx.userId });
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "complete_sprint",
    {
      description: "Complete a sprint. Not-done issues carry to carryToSprintId if given, else back to the backlog.",
      inputSchema: { sprintId: z.string().min(1), carryToSprintId: z.string().optional() },
    },
    (args) =>
      tool(ctx, "sprints:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const sprint = await resolveSprint(tx, ctx.organizationId, args.sprintId);
          if (args.carryToSprintId) await resolveSprint(tx, ctx.organizationId, args.carryToSprintId);
          return completeSprint(tx, { sprintId: sprint.id, actorId: ctx.userId, carryToSprintId: args.carryToSprintId });
        }),
      )(),
  );

  // ── Projects & people ────────────────────────────────────────────────

  server.registerTool(
    "get_project",
    {
      description:
        "Everything needed to file and edit issues in a project: its issue types, workflow statuses, priority levels, custom properties, epics, and the members issues can be assigned to.",
      inputSchema: { projectKey: z.string().min(1) },
    },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const project = await resolveProject(tx, ctx.organizationId, args.projectKey);
          const [types, statuses, priorities, properties, epics, members] = await Promise.all([
            tx.select().from(schema.issueType).where(eq(schema.issueType.projectId, project.id)).orderBy(asc(schema.issueType.order)),
            tx.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, project.id)).orderBy(asc(schema.workflowStatus.order)),
            listPriorityLevels(tx, project.id),
            listIssuePropertyDefinitions(tx, project.id),
            listCandidateEpics(tx, project.id),
            listAssignableUsers(tx, { organizationId: ctx.organizationId, projectId: project.id }),
          ]);
          return {
            id: project.id,
            key: project.key,
            name: project.name,
            teamId: project.teamId,
            issueTypes: types.map((t) => ({ name: t.name, isSubtask: t.isSubtask, hierarchyLevel: t.hierarchyLevel })),
            statuses: statuses.map((s) => ({ name: s.name, category: s.category })),
            priorities: priorities.map((p) => p.key),
            properties: properties.map((p) => ({ key: p.key, name: p.name, type: p.type, options: p.options })),
            epics: epics.map((e) => ({ key: `${project.key}-${e.keySeq}`, title: e.title })),
            members,
          };
        }),
      )(),
  );

  server.registerTool(
    "list_teams",
    { description: "List the workspace's teams. Team ids are what create_page's teamId and set_page_access's team subject take." },
    tool(ctx, null, () => withAuthorizedTenant(ctx, (tx) => listTeamsForWorkspace(tx, ctx))),
  );

  // ── Issues: comments, links, time, checklist, watching, archive ───────

  server.registerTool(
    "list_issue_comments",
    { description: "List an issue's comments, oldest first, as plain text.", inputSchema: { issueKey: z.string().min(1) } },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          const comments = await listComments(tx, issue.id);
          return comments.map((c) => ({
            id: c.id,
            authorId: c.authorId,
            parentCommentId: c.parentCommentId,
            text: toPlainText(c.bodyJson),
            origin: c.origin,
            createdAt: c.createdAt,
          }));
        }),
      )(),
  );

  server.registerTool(
    "set_issue_property",
    {
      description: "Set one custom property on an issue (see get_project for the project's property keys). value null clears it.",
      inputSchema: {
        issueKey: z.string().min(1),
        key: z.string().min(1),
        value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
      },
    },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { project, issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          const definitions = await listIssuePropertyDefinitions(tx, project.id);
          if (!definitions.some((d) => d.key === args.key)) {
            throw new ApiError(400, "Bad Request", `Property "${args.key}" is not defined in project ${project.key}`);
          }
          await updateIssueCustomField(tx, issue.id, args.key, args.value as Json, { actorId: ctx.userId, origin: ctx.origin, originClient: "mcp" });
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "link_issues",
    {
      description: "Link two issues. Directional, as in JIRA: fromIssueKey \"blocks\"/\"duplicates\"/\"clones\" toIssueKey; \"relates\" reads either way.",
      inputSchema: {
        fromIssueKey: z.string().min(1),
        toIssueKey: z.string().min(1),
        type: z.enum(["blocks", "relates", "duplicates", "clones"]),
      },
    },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const [{ issue: from }, { issue: to }] = await Promise.all([
            resolveIssue(tx, ctx.organizationId, args.fromIssueKey),
            resolveIssue(tx, ctx.organizationId, args.toIssueKey),
          ]);
          if (from.id === to.id) throw new ApiError(400, "Bad Request", "An issue can't be linked to itself");
          return linkIssues(tx, { fromIssueId: from.id, toIssueId: to.id, type: args.type });
        }),
      )(),
  );

  server.registerTool(
    "log_work",
    {
      description: "Log time spent on an issue. Adds to the issue's spent time.",
      inputSchema: {
        issueKey: z.string().min(1),
        seconds: z.number().int().positive(),
        note: z.string().optional(),
        loggedAt: z.iso.datetime().optional().describe("When the work happened. Defaults to now."),
      },
    },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          return logWork(tx, {
            issueId: issue.id,
            userId: ctx.userId,
            seconds: args.seconds,
            note: args.note,
            loggedAt: args.loggedAt ? new Date(args.loggedAt) : undefined,
          });
        }),
      )(),
  );

  server.registerTool(
    "list_worklogs",
    { description: "List the time logged on an issue.", inputSchema: { issueKey: z.string().min(1) } },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          const worklogs = await listWorklogs(tx, issue.id);
          return worklogs.map((w) => ({ id: w.id, userId: w.userId, seconds: w.seconds, note: w.note, loggedAt: w.loggedAt }));
        }),
      )(),
  );

  server.registerTool(
    "list_attachments",
    { description: "List an issue's file attachments with short-lived download URLs.", inputSchema: { issueKey: z.string().min(1) } },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          const attachments = await listAttachments(tx, issue.id);
          return attachments.map((a) => ({
            id: a.id,
            fileName: a.fileName,
            contentType: a.contentType,
            sizeBytes: a.sizeBytes,
            uploaderId: a.uploaderId,
            createdAt: a.createdAt,
            downloadUrl: a.downloadUrl,
          }));
        }),
      )(),
  );

  server.registerTool(
    "add_checklist_item",
    { description: "Add a to-do line to an issue's checklist.", inputSchema: { issueKey: z.string().min(1), text: z.string().min(1).max(500) } },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          return addChecklistItem(tx, { issueId: issue.id, text: args.text, createdBy: ctx.userId });
        }),
      )(),
  );

  server.registerTool(
    "update_checklist_item",
    {
      description: "Check off, rename, reorder (move: up/down), or delete (delete: true) an issue's checklist item. Item ids come from get_issue.",
      inputSchema: {
        issueKey: z.string().min(1),
        itemId: z.string().min(1),
        text: z.string().min(1).max(500).optional(),
        done: z.boolean().optional(),
        move: z.enum(["up", "down"]).optional(),
        delete: z.boolean().optional(),
      },
    },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          const items = await listChecklistItems(tx, issue.id);
          if (!items.some((i) => i.id === args.itemId)) throw new ApiError(404, "Not Found", `Checklist item ${args.itemId} not found on ${args.issueKey}`);
          if (args.delete) {
            await deleteChecklistItem(tx, args.itemId);
            return { ok: true };
          }
          if (args.text !== undefined || args.done !== undefined) await updateChecklistItem(tx, { itemId: args.itemId, text: args.text, done: args.done });
          if (args.move) await moveChecklistItem(tx, { itemId: args.itemId, direction: args.move });
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "watch_issue",
    { description: "Start (watching: true) or stop watching an issue, i.e. get notified of its changes.", inputSchema: { issueKey: z.string().min(1), watching: z.boolean() } },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          await setWatching(tx, { issueId: issue.id, userId: ctx.userId, watching: args.watching });
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "archive_issue",
    {
      description: "Archive (soft-delete) an issue, or bring it back with restore: true. Project admins and the team admin only, as in the UI.",
      inputSchema: { issueKey: z.string().min(1), restore: z.boolean().optional() },
    },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { project, issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          await requireIssueAdmin(tx, ctx, project.id);
          const meta = { actorId: ctx.userId, origin: ctx.origin, originClient: "mcp" };
          if (args.restore) await restoreIssue(tx, issue.id, meta);
          else await archiveIssue(tx, issue.id, meta);
          return { ok: true, archived: !args.restore };
        }),
      )(),
  );

  server.registerTool(
    "list_backlog",
    { description: "List a project's backlog: open issues not in any sprint, in backlog order.", inputSchema: { projectKey: z.string().min(1) } },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const project = await resolveProject(tx, ctx.organizationId, args.projectKey);
          const issues = await listBacklogIssues(tx, project.id);
          return issues.map((i) => serializeIssue(i, project.key));
        }),
      )(),
  );

  // ── Sprints ──────────────────────────────────────────────────────────

  server.registerTool(
    "create_sprint",
    {
      description: "Create a sprint on a project's board. Name defaults to the next \"Sprint N\".",
      inputSchema: {
        projectKey: z.string().min(1),
        name: z.string().min(1).optional(),
        goal: z.string().optional(),
        cycle: z.enum(["1w", "2w", "3w", "4w", "custom"]).optional(),
        startAt: z.iso.datetime().optional(),
        endAt: z.iso.datetime().optional(),
        capacityPoints: z.number().optional(),
      },
    },
    (args) =>
      tool(ctx, "sprints:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const project = await resolveProject(tx, ctx.organizationId, args.projectKey);
          const board = await resolveBoardForProject(tx, project.id);
          return createSprint(tx, {
            organizationId: ctx.organizationId,
            boardId: board.id,
            name: args.name,
            goal: args.goal,
            cycle: args.cycle,
            startAt: args.startAt ? new Date(args.startAt) : undefined,
            endAt: args.endAt ? new Date(args.endAt) : undefined,
            capacityPoints: args.capacityPoints,
            actorUserId: ctx.userId,
          });
        }),
      )(),
  );

  server.registerTool(
    "rename_sprint",
    { description: "Rename a sprint.", inputSchema: { sprintId: z.string().min(1), name: z.string().min(1) } },
    (args) =>
      tool(ctx, "sprints:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const sprint = await resolveSprint(tx, ctx.organizationId, args.sprintId);
          await updateSprint(tx, { sprintId: sprint.id, name: args.name });
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "list_sprint_issues",
    { description: "List the issues in a sprint.", inputSchema: { sprintId: z.string().min(1) } },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const sprint = await resolveSprint(tx, ctx.organizationId, args.sprintId);
          const issues = await listSprintIssues(tx, sprint.id);
          const keys = await issueKeysById(tx, issues.map((i) => i.id));
          return issues.map((i) => ({ key: keys.get(i.id) ?? null, id: i.id, title: i.title, statusId: i.statusId, assigneeId: i.assigneeId, storyPoints: i.storyPoints }));
        }),
      )(),
  );

  server.registerTool(
    "move_issue_to_sprint",
    {
      description: "Put an issue into a sprint (moving it out of any other), or back to the backlog by omitting sprintId.",
      inputSchema: { issueKey: z.string().min(1), sprintId: z.string().optional() },
    },
    (args) =>
      tool(ctx, "sprints:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          const actor = { actorId: ctx.userId, origin: ctx.origin, originClient: "mcp" };
          if (args.sprintId) {
            const sprint = await resolveSprint(tx, ctx.organizationId, args.sprintId);
            if (sprint.state === "closed") throw new ApiError(400, "Bad Request", "Can't add an issue to a closed sprint");
            await addIssueToSprint(tx, sprint.id, issue.id, actor);
          } else {
            await removeIssueFromSprint(tx, issue.id, actor);
          }
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "get_sprint_charts",
    { description: "Day-by-day burndown and cumulative-flow series for a sprint.", inputSchema: { sprintId: z.string().min(1) } },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const sprint = await resolveSprint(tx, ctx.organizationId, args.sprintId);
          const [burndown, cumulativeFlow] = await Promise.all([getBurndown(tx, sprint.id), getCumulativeFlow(tx, sprint.id)]);
          return { burndown, cumulativeFlow };
        }),
      )(),
  );

  server.registerTool(
    "get_velocity",
    { description: "Committed vs completed story points for a project's recent sprints.", inputSchema: { projectKey: z.string().min(1) } },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const project = await resolveProject(tx, ctx.organizationId, args.projectKey);
          const board = await resolveBoardForProject(tx, project.id);
          return getVelocityHistory(tx, board.id);
        }),
      )(),
  );

  // ── Docs ─────────────────────────────────────────────────────────────

  server.registerTool(
    "search_pages",
    { description: "Find doc pages by title.", inputSchema: { query: z.string().min(1), limit: z.number().int().positive().max(50).optional() } },
    (args) =>
      tool(ctx, "pages:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const rows = await tx
            .select()
            .from(schema.page)
            .where(and(eq(schema.page.organizationId, ctx.organizationId), isNull(schema.page.archivedAt), ilike(schema.page.title, `%${args.query.trim()}%`)))
            .orderBy(asc(schema.page.title))
            .limit(200);
          const visible = await filterAccessiblePages(tx, rows, ctx);
          return { data: visible.slice(0, args.limit ?? 20).map(serializePage) };
        }),
      )(),
  );

  server.registerTool(
    "list_page_comments",
    { description: "List a page's open (unresolved) comments.", inputSchema: { pageId: z.string().min(1) } },
    (args) =>
      tool(ctx, "pages:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          await resolvePage(tx, ctx, args.pageId, "view");
          const comments = await listPageComments(tx, args.pageId);
          return comments.map((c) => ({ id: c.id, blockId: c.blockId, authorId: c.authorId, text: toPlainText(c.bodyJson), createdAt: c.createdAt }));
        }),
      )(),
  );

  server.registerTool(
    "resolve_page_comment",
    { description: "Mark a page comment resolved.", inputSchema: { pageId: z.string().min(1), commentId: z.string().min(1) } },
    (args) =>
      tool(ctx, "pages:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          await resolvePage(tx, ctx, args.pageId, "comment");
          const [comment] = await tx
            .select({ id: schema.pageComment.id })
            .from(schema.pageComment)
            .where(and(eq(schema.pageComment.id, args.commentId), eq(schema.pageComment.pageId, args.pageId)));
          if (!comment) throw new ApiError(404, "Not Found", `Comment ${args.commentId} not found on page ${args.pageId}`);
          await resolvePageComment(tx, comment.id);
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "get_page_links",
    { description: "Issues a page is linked to, and pages that mention it (backlinks).", inputSchema: { pageId: z.string().min(1) } },
    (args) =>
      tool(ctx, "pages:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          await resolvePage(tx, ctx, args.pageId, "view");
          const [outgoing, backlinks] = await Promise.all([listOutgoingLinks(tx, "page", args.pageId), listBacklinks(tx, "page", args.pageId)]);
          const keys = await issueKeysById(tx, outgoing.filter((l) => l.toType === "issue").map((l) => l.toId));
          const mentionedById = backlinks.filter((l) => l.fromType === "page").map((l) => l.fromId);
          const mentionedBy = mentionedById.length
            ? await filterAccessiblePages(tx, await tx.select().from(schema.page).where(and(inArray(schema.page.id, mentionedById), isNull(schema.page.archivedAt))), ctx)
            : [];
          return { linkedIssues: [...keys.values()], mentionedBy: mentionedBy.map((p) => ({ id: p.id, title: p.title })) };
        }),
      )(),
  );

  server.registerTool(
    "unlink_page_from_issue",
    { description: "Remove a link between a doc page and an issue.", inputSchema: { pageId: z.string().min(1), issueKey: z.string().min(1) } },
    (args) =>
      tool(ctx, "pages:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          await resolvePage(tx, ctx, args.pageId, "edit");
          const { issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          await unlinkEntities(tx, { fromType: "page", fromId: args.pageId, toType: "issue", toId: issue.id });
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "move_page",
    {
      description:
        "Move a page (with its sub-pages). Give parentPageId to nest it under another page (it joins that page's space), or omit it to move it to the top of a space: projectKey, teamId, private, or none of them for the shared Workspace.",
      inputSchema: {
        pageId: z.string().min(1),
        parentPageId: z.string().optional(),
        projectKey: z.string().optional(),
        teamId: z.string().optional(),
        private: z.boolean().optional(),
      },
    },
    (args) =>
      tool(ctx, "pages:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const page = await resolvePage(tx, ctx, args.pageId, "edit");
          // Into or out of a Private/Shared space changes who can see the
          // page, so it needs the right to change its access, not just edit
          // (same rule as the UI's Move to… and drag-to-nest).
          const requireManage = async () => {
            if (!(await canManagePageAccess(tx, page.id, ctx))) {
              throw new ForbiddenError(`Only someone who manages access to page ${page.id} can move it into or out of a private space`);
            }
          };
          if (args.parentPageId) {
            if (args.projectKey || args.teamId || args.private) throw new ApiError(400, "Bad Request", "Give parentPageId or a target space, not both");
            const parent = await resolvePage(tx, ctx, args.parentPageId, "edit");
            const crossesPersonal =
              (page.privateOwnerId || parent.privateOwnerId) &&
              (page.privateOwnerId !== parent.privateOwnerId || page.projectId !== parent.projectId || page.teamId !== parent.teamId);
            if (crossesPersonal) await requireManage();
            await movePage(tx, page.id, { parentPageId: parent.id });
            return { ok: true };
          }
          const projectId = args.projectKey ? (await resolveProject(tx, ctx.organizationId, args.projectKey)).id : null;
          if (args.teamId) await requireTeamMember(tx, { ...ctx, teamId: args.teamId });
          if (args.private || page.privateOwnerId) await requireManage();
          await movePage(tx, page.id, {
            parentPageId: null,
            space: { projectId, teamId: args.teamId ?? null, privateOwnerId: args.private ? ctx.userId : null },
          });
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "duplicate_page",
    {
      description: "Copy a page (content included) next to the original, or create a new page from a template by passing a template's id (see list_templates) and parentPageId.",
      inputSchema: { pageId: z.string().min(1), parentPageId: z.string().nullable().optional(), titleSuffix: z.string().optional() },
    },
    (args) =>
      tool(ctx, "pages:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const source = await resolvePage(tx, ctx, args.pageId, "view");
          // The copy doesn't carry the source's access list, so copying a
          // restricted page would publish it to its whole space — only
          // someone who decides who sees it may do that.
          const { grants } = await getPageAccess(tx, source.id, ctx);
          if (grants.length > 0 && !(await canManagePageAccess(tx, source.id, ctx))) {
            throw new ForbiddenError(`Page ${source.id} is restricted; only someone who manages its access can copy it`);
          }
          if (args.parentPageId) await resolvePage(tx, ctx, args.parentPageId, "edit");
          const copy = await duplicatePage(tx, source.id, {
            actorUserId: ctx.userId,
            parentPageId: args.parentPageId,
            titleSuffix: args.titleSuffix ?? (source.type === "template" ? "" : " (copy)"),
          });
          return serializePage(copy);
        }),
      )(),
  );

  server.registerTool(
    "list_templates",
    { description: "List page templates." },
    tool(ctx, "pages:read", () =>
      withAuthorizedTenant(ctx, async (tx) => {
        const templates = await filterAccessiblePages(tx, await listTemplatePages(tx, ctx.organizationId), ctx);
        return { data: templates.map(serializePage) };
      }),
    ),
  );

  server.registerTool(
    "set_page_template",
    { description: "Turn a page into a template (isTemplate: true) or back into an ordinary doc.", inputSchema: { pageId: z.string().min(1), isTemplate: z.boolean() } },
    (args) =>
      tool(ctx, "pages:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          await resolvePage(tx, ctx, args.pageId, "edit");
          await updatePageMeta(tx, args.pageId, { type: args.isTemplate ? "template" : "doc" });
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "archive_page",
    {
      description: "Move a page and its sub-pages to the trash, or bring a trashed page back with restore: true.",
      inputSchema: { pageId: z.string().min(1), restore: z.boolean().optional() },
    },
    (args) =>
      tool(ctx, "pages:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          await resolvePage(tx, ctx, args.pageId, "edit");
          if (args.restore) await restorePage(tx, args.pageId);
          else await archivePage(tx, args.pageId);
          return { ok: true, archived: !args.restore };
        }),
      )(),
  );

  server.registerTool(
    "list_trash",
    { description: "List trashed (archived) pages, most recently trashed first." },
    tool(ctx, "pages:read", () =>
      withAuthorizedTenant(ctx, async (tx) => {
        const pages = await filterAccessiblePages(tx, await listArchivedPages(tx, ctx.organizationId), ctx);
        return { data: pages.map((p) => ({ ...serializePage(p), archivedAt: p.archivedAt })) };
      }),
    ),
  );

  server.registerTool(
    "delete_page_permanently",
    {
      description: "Permanently delete a page that's already in the trash. Can't be undone. Needs full access to the page.",
      inputSchema: { pageId: z.string().min(1) },
    },
    (args) =>
      tool(ctx, "pages:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const page = await resolvePage(tx, ctx, args.pageId, "full");
          if (!page.archivedAt) throw new ApiError(400, "Bad Request", "Move the page to the trash first (archive_page)");
          await permanentlyDeletePage(tx, page.id);
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "list_page_versions",
    { description: "List a page's saved versions, newest first.", inputSchema: { pageId: z.string().min(1) } },
    (args) =>
      tool(ctx, "pages:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          await resolvePage(tx, ctx, args.pageId, "view");
          return listPageVersions(tx, args.pageId);
        }),
      )(),
  );

  server.registerTool(
    "get_page_version",
    {
      description: "Read an earlier version of a page as Markdown. Read-only: restoring a version is done in the editor, since writing over the live document would race anyone editing it.",
      inputSchema: { pageId: z.string().min(1), versionId: z.string().min(1) },
    },
    (args) =>
      tool(ctx, "pages:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          await resolvePage(tx, ctx, args.pageId, "view");
          const snapshot = await getPageVersionSnapshot(tx, args.pageId, args.versionId);
          if (!snapshot) throw new ApiError(404, "Not Found", `Version ${args.versionId} not found`);
          return { versionId: args.versionId, content: await yjsStateToMarkdown(snapshot) };
        }),
      )(),
  );

  server.registerTool(
    "favorite_page",
    { description: "Add a page to, or remove it from, your sidebar favorites.", inputSchema: { pageId: z.string().min(1), favorite: z.boolean() } },
    (args) =>
      tool(ctx, "pages:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          await resolvePage(tx, ctx, args.pageId, "view");
          const isFavorite = (await listFavoritePageIds(tx, ctx.userId)).includes(args.pageId);
          if (isFavorite !== args.favorite) await toggleFavoritePage(tx, args.pageId, ctx.userId);
          return { ok: true, favorite: args.favorite };
        }),
      )(),
  );

  // ── Automation ───────────────────────────────────────────────────────

  const automationNodeSchema = z.object({
    id: z.string().min(1),
    type: z.enum(schema.automationWorkflowNodeType),
    name: z.string().min(1).optional(),
    config: z.record(z.string(), z.any()),
    position: z.object({ x: z.number(), y: z.number() }),
  });
  const automationEdgeSchema = z.object({ fromNodeId: z.string().min(1), fromHandle: z.string().min(1).optional(), toNodeId: z.string().min(1) });

  /** Workflow ids aren't project-scoped by themselves; this keeps a caller from reaching one through the wrong project key. */
  async function resolveWorkflow(tx: Tx, projectKey: string, workflowId: string) {
    const project = await resolveProject(tx, ctx.organizationId, projectKey);
    const workflow = await getWorkflow(tx, workflowId);
    if (!workflow || workflow.projectId !== project.id) throw new ApiError(404, "Not Found", `Workflow ${workflowId} not found in ${project.key}`);
    return { project, workflow };
  }

  server.registerTool(
    "list_automations",
    { description: "List a project's automation workflows.", inputSchema: { projectKey: z.string().min(1) } },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const project = await resolveProject(tx, ctx.organizationId, args.projectKey);
          return listWorkflows(tx, project.id);
        }),
      )(),
  );

  server.registerTool(
    "get_automation",
    { description: "Get an automation workflow's nodes and edges.", inputSchema: { projectKey: z.string().min(1), workflowId: z.string().min(1) } },
    (args) =>
      tool(ctx, "issues:read", () => withAuthorizedTenant(ctx, async (tx) => (await resolveWorkflow(tx, args.projectKey, args.workflowId)).workflow))(),
  );

  server.registerTool(
    "save_automation",
    {
      description:
        "Create an automation workflow (omit workflowId) or update one. A workflow is a graph: trigger nodes (trigger_event, trigger_schedule), conditions, and actions, joined by edges. nodes and edges always go together and replace the whole graph. Use dryRun to log what it would do without doing it.",
      inputSchema: {
        projectKey: z.string().min(1),
        workflowId: z.string().optional(),
        name: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        nodes: z.array(automationNodeSchema).optional(),
        edges: z.array(automationEdgeSchema).optional(),
      },
    },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          if ((args.nodes === undefined) !== (args.edges === undefined)) throw new ApiError(400, "Bad Request", "nodes and edges must be sent together");
          if (!args.workflowId) {
            if (!args.name || !args.nodes || !args.edges) throw new ApiError(400, "Bad Request", "A new workflow needs name, nodes and edges");
            const project = await resolveProject(tx, ctx.organizationId, args.projectKey);
            return createWorkflow(tx, {
              organizationId: ctx.organizationId,
              projectId: project.id,
              name: args.name,
              dryRun: args.dryRun,
              createdBy: ctx.userId,
              nodes: args.nodes,
              edges: args.edges,
            });
          }
          const { project } = await resolveWorkflow(tx, args.projectKey, args.workflowId);
          await updateWorkflow(tx, {
            workflowId: args.workflowId,
            projectId: project.id,
            name: args.name,
            enabled: args.enabled,
            dryRun: args.dryRun,
            nodes: args.nodes,
            edges: args.edges,
          });
          return { workflowId: args.workflowId };
        }),
      )(),
  );

  server.registerTool(
    "delete_automation",
    { description: "Delete an automation workflow and its run history.", inputSchema: { projectKey: z.string().min(1), workflowId: z.string().min(1) } },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          await resolveWorkflow(tx, args.projectKey, args.workflowId);
          await deleteWorkflow(tx, args.workflowId);
          return { ok: true };
        }),
      )(),
  );

  server.registerTool(
    "list_automation_runs",
    {
      description: "List an automation workflow's recent runs, or pass runId for one run's per-node steps.",
      inputSchema: { projectKey: z.string().min(1), workflowId: z.string().min(1), runId: z.string().optional() },
    },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          await resolveWorkflow(tx, args.projectKey, args.workflowId);
          if (!args.runId) return listWorkflowRuns(tx, args.workflowId);
          const run = await getWorkflowRun(tx, args.runId);
          if (!run || run.workflowId !== args.workflowId) throw new ApiError(404, "Not Found", `Run ${args.runId} not found`);
          return run;
        }),
      )(),
  );

  // ── Notifications ────────────────────────────────────────────────────

  server.registerTool(
    "list_notifications",
    { description: "Your most recent notifications (newest first).", inputSchema: { limit: z.number().int().positive().max(100).optional(), unreadOnly: z.boolean().optional() } },
    (args) =>
      tool(ctx, null, () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const rows = await listNotifications(tx, ctx.organizationId, ctx.userId, args.limit ?? 30);
          return args.unreadOnly ? rows.filter((n) => !n.readAt) : rows;
        }),
      )(),
  );

  server.registerTool(
    "mark_notifications_read",
    { description: "Mark one notification read (notificationId), or all of yours (omit it).", inputSchema: { notificationId: z.string().optional() } },
    (args) =>
      tool(ctx, null, () =>
        withAuthorizedTenant(ctx, async (tx) => {
          if (args.notificationId) await markNotificationRead(tx, args.notificationId, ctx.userId);
          else await markAllNotificationsRead(tx, ctx.organizationId, ctx.userId);
          return { ok: true };
        }),
      )(),
  );

  server.registerResource(
    "issue",
    new ResourceTemplate("kompast://issue/{key}", { list: undefined }),
    { description: "An issue, addressable by key (e.g. kompast://issue/KPT-42)." },
    async (uri, variables) => {
      if (!hasScope(ctx, "issues:read")) throw new Error("Missing required token scope: issues:read");
      const key = String(variables.key);
      const data = await withAuthorizedTenant(ctx, async (tx) => {
        const { project, issue } = await resolveIssue(tx, ctx.organizationId, key);
        return serializeIssue(issue, project.key);
      });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }] };
    },
  );

  server.registerResource(
    "page",
    new ResourceTemplate("kompast://page/{id}", { list: undefined }),
    { description: "A doc page, addressable by id (e.g. kompast://page/pg_abc123)." },
    async (uri, variables) => {
      if (!hasScope(ctx, "pages:read")) throw new Error("Missing required token scope: pages:read");
      const id = String(variables.id);
      const data = await withAuthorizedTenant(ctx, async (tx) => {
        const page = await resolvePage(tx, ctx, id, "view");
        const content = await renderPageMarkdown(tx, page.id);
        return { ...serializePage(page), content };
      });
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: data.content || JSON.stringify(data) }] };
    },
  );

  server.registerPrompt(
    "bug-report",
    { description: "Draft a well-structured bug report and file it as an issue.", argsSchema: { summary: z.string().min(1) } },
    ({ summary }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Draft a bug report for: "${summary}". Ask me for anything missing (repro steps, expected vs actual, ` +
              `environment, severity), then call create_issue with a project key I confirm and priority inferred from severity.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "pr-to-issue",
    { description: "Turn a PR's description/diff into follow-up issues.", argsSchema: { prDescription: z.string().min(1) } },
    ({ prDescription }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Here is a pull request description:\n\n${prDescription}\n\n` +
              `Identify any follow-up work it implies (TODOs, deferred edge cases, tests to add) and call create_issue ` +
              `once per follow-up item, asking me which project key to use if it's ambiguous.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "standup-digest",
    { description: "Summarize what I've moved in the last 2 days for a standup update." },
    async () => {
      const rows = await withAuthorizedTenant(ctx, (tx) =>
        tx
          .select({ title: schema.issue.title, keySeq: schema.issue.keySeq, projectKey: schema.project.key, statusName: schema.workflowStatus.name, updatedAt: schema.issue.updatedAt })
          .from(schema.issue)
          .innerJoin(schema.project, eq(schema.project.id, schema.issue.projectId))
          .innerJoin(schema.workflowStatus, eq(schema.workflowStatus.id, schema.issue.statusId))
          .where(and(eq(schema.issue.organizationId, ctx.organizationId), eq(schema.issue.assigneeId, ctx.userId)))
          .orderBy(schema.issue.updatedAt),
      );
      const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
      const recent = rows.filter((r) => r.updatedAt.getTime() >= cutoff);
      const lines = recent.map((r) => `- ${r.projectKey}-${r.keySeq} ${r.title} → ${r.statusName}`).join("\n") || "(nothing moved in the last 2 days)";
      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text: `Write a short standup update from this activity:\n\n${lines}\n\nGroup into Yesterday / Today / Blockers.` },
          },
        ],
      };
    },
  );

  return server;
}
