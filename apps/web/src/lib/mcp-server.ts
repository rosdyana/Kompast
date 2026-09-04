import * as z from "zod";
import * as Y from "yjs";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, asc, eq, gt, isNull, schema } from "@kompast/db";
import {
  createIssue,
  updateIssue,
  moveIssue,
  addComment,
  createPage,
  updatePageMeta,
  addPageComment,
  linkEntities,
  listPageTree,
  filterAccessiblePages,
  searchWorkspace,
  withAuthorizedTenant,
  withIdempotency,
  ForbiddenError,
  listSprints,
  getSprintReport,
  startSprint,
  completeSprint,
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
    type: page.type,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
  };
}

async function renderPageMarkdown(tx: import("@kompast/core").Tx, pageId: string): Promise<string> {
  const [state] = await tx.select().from(schema.ydocState).where(eq(schema.ydocState.pageId, pageId));
  if (!state) return "";
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, state.state);
  const editor = ServerBlockNoteEditor.create({ schema: createServerSchema() as any });
  const blocks = editor.yDocToBlocks(ydoc, "document-store");
  return editor.blocksToMarkdownLossy(blocks);
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
          return tx.select({ id: schema.board.id, name: schema.board.name, type: schema.board.type }).from(schema.board).where(eq(schema.board.projectId, project.id));
        }),
      )(),
  );

  server.registerTool(
    "list_issues",
    {
      description: "List issues in a project, oldest key first.",
      inputSchema: { projectKey: z.string().min(1), cursor: z.number().int().optional(), limit: z.number().int().positive().max(100).optional() },
    },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const project = await resolveProject(tx, ctx.organizationId, args.projectKey);
          const limit = args.limit ?? 25;
          const rows = await tx
            .select()
            .from(schema.issue)
            .where(and(eq(schema.issue.projectId, project.id), gt(schema.issue.keySeq, args.cursor ?? 0)))
            .orderBy(asc(schema.issue.keySeq))
            .limit(limit);
          const nextCursor = rows.length === limit ? rows[rows.length - 1]!.keySeq : null;
          return { data: rows.map((r) => serializeIssue(r, project.key)), nextCursor };
        }),
      )(),
  );

  server.registerTool(
    "get_issue",
    { description: "Get a single issue by its key (e.g. KPT-42).", inputSchema: { issueKey: z.string().min(1) } },
    (args) =>
      tool(ctx, "issues:read", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { project, issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          return serializeIssue(issue, project.key);
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
        priority: z.enum(["lowest", "low", "medium", "high", "highest"]).optional(),
        assigneeEmail: z.email().optional(),
        description: z.string().optional(),
        labels: z.array(z.string()).optional(),
        storyPoints: z.number().optional(),
        dueDate: z.string().optional(),
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
            const created = await createIssue(tx, {
              organizationId: ctx.organizationId,
              projectId: project.id,
              typeId: type.id,
              statusId: status.id,
              title: args.title,
              reporterId: ctx.userId,
              assigneeId,
              priority: args.priority,
              descriptionJson: args.description ? { text: args.description } : undefined,
              labels: args.labels,
              storyPoints: args.storyPoints,
              dueDate: args.dueDate ? new Date(args.dueDate) : undefined,
              origin: ctx.origin,
              originClient: "mcp",
            });
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
        priority: z.enum(["lowest", "low", "medium", "high", "highest"]).optional(),
        storyPoints: z.number().nullable().optional(),
        dueDate: z.string().nullable().optional(),
        labels: z.array(z.string()).optional(),
        description: z.string().optional(),
      },
    },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          await updateIssue(tx, issue.id, {
            title: args.title,
            priority: args.priority,
            storyPoints: args.storyPoints,
            dueDate: args.dueDate === undefined ? undefined : args.dueDate === null ? null : new Date(args.dueDate),
            labels: args.labels,
            descriptionJson: args.description !== undefined ? { text: args.description } : undefined,
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
      description: "Add a comment to an issue.",
      inputSchema: { issueKey: z.string().min(1), text: z.string().min(1) },
    },
    (args) =>
      tool(ctx, "issues:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const { issue } = await resolveIssue(tx, ctx.organizationId, args.issueKey);
          const result = await addComment(tx, { issueId: issue.id, authorId: ctx.userId, bodyJson: { text: args.text }, origin: ctx.origin, originClient: "mcp" });
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
        parentPageId: z.string().nullable().optional(),
        content: z.string().optional(),
        idempotencyKey: z.string().optional(),
      },
    },
    (args) =>
      tool(ctx, "pages:write", () =>
        withAuthorizedTenant(ctx, async (tx) => {
          const run = async () => {
            const projectId = args.projectKey ? (await resolveProject(tx, ctx.organizationId, args.projectKey)).id : null;
            const page = await createPage(tx, {
              organizationId: ctx.organizationId,
              title: args.title,
              parentPageId: args.parentPageId,
              projectId,
              actorUserId: ctx.userId,
            });
            // Safe only because this page is brand new — see pages.tsx (REST) for the full explanation.
            if (args.content) {
              const editor = ServerBlockNoteEditor.create({ schema: createServerSchema() as any });
              const blocks = await editor.tryParseMarkdownToBlocks(args.content);
              const ydoc = editor.blocksToYDoc(blocks, "document-store");
              await tx.insert(schema.ydocState).values({ pageId: page.id, state: Buffer.from(Y.encodeStateAsUpdate(ydoc)) });
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
