import { and, asc, eq, inArray, schema, sql } from "@kompast/db";
import type { AiToolCall, AiToolDefinition } from "@kompast/ai";
import { withAuthorizedTenant, ForbiddenError, type AuthContext } from "./permissions";
import { resolveIssue, resolveProject, resolveUserByEmail, queryIssues } from "./issue-query";
import { ConflictError, InvalidInputError, NotFoundError } from "./errors";
import { getActiveSprint, getSprintReport, listSprints } from "./sprint";
import { listComments } from "./comment";
import { toPlainText } from "./rich-text";
import { getEmbeddingCredentials } from "./settings";
import { contextHeader, EmbeddingNotConfiguredError, retrieveContext } from "./rag";
import { loadIssueFacts, type IssueFacts } from "./rag-enrich";
import type { Tx } from "./types";

/** Upper bound on any single tool result the model sees, in characters. Keeps one lookup from crowding the context window. */
const MAX_TOOL_OUTPUT_CHARS = 4000;
const DESCRIPTION_CHARS = 1500;
const COMMENT_CHARS = 500;
const EXCERPT_CHARS = 300;
const RECENT_COMMENTS = 5;
const DEFAULT_ISSUE_LIMIT = 15;
const MAX_ISSUE_LIMIT = 25;

/**
 * The read-only tools the model may call during Ask Kompast. Every handler
 * runs on its own withAuthorizedTenant transaction, so results are limited to
 * what the asking user can see — the tools add no visibility of their own.
 */
export const askTools: AiToolDefinition[] = [
  {
    name: "list_projects",
    description: "List the projects the user can see, with each project's key, name and team.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_issues",
    description:
      "List issues, most recently updated first unless a projectKey is given (then oldest key first). Use this for status, assignee, sprint, label, 'list all' and count questions.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: { type: "string", description: "Project key, e.g. KMP." },
        status: { type: "string", description: 'Workflow status name, e.g. "In Progress".' },
        assignee: { type: "string", description: 'Use "me" for the asking user, a workspace member\'s email, or their exact name.' },
        sprint: { type: "string", description: '"active" for the project\'s active sprint, or an exact sprint name. Requires projectKey.' },
        label: { type: "string" },
        includeArchived: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: MAX_ISSUE_LIMIT, description: `Default ${DEFAULT_ISSUE_LIMIT}.` },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_issue",
    description: "Get one issue by key (e.g. KMP-42): its current status, assignee, sprint, labels, description and the most recent comments.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "Issue key, e.g. KMP-42." } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "get_sprint",
    description: "Get a sprint's name, state, goal, dates and scope/completion numbers.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: { type: "string", description: "Project key that owns the sprint's board." },
        sprint: { type: "string", description: '"active" or an exact sprint name.' },
      },
      required: ["projectKey", "sprint"],
      additionalProperties: false,
    },
  },
  {
    name: "search_workspace",
    description: "Semantic search across issue text, comments and docs when you don't know which issue or doc is meant. Returns short excerpts.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Compact JSON, cut to MAX_TOOL_OUTPUT_CHARS as a valid JSON wrapper rather than a half-written object. */
function encodeToolOutput(value: unknown): string {
  const json = JSON.stringify(value);
  if (json.length <= MAX_TOOL_OUTPUT_CHARS) return json;
  return JSON.stringify({ truncated: true, preview: json.slice(0, MAX_TOOL_OUTPUT_CHARS - 200) });
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new InvalidInputError(`"${key}" must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = readString(input, key);
  if (!value) throw new InvalidInputError(`"${key}" is required`);
  return value;
}

function readBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new InvalidInputError(`"${key}" must be true or false`);
  return value;
}

function readLimit(input: Record<string, unknown>): number {
  const value = input.limit;
  if (value === undefined || value === null) return DEFAULT_ISSUE_LIMIT;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new InvalidInputError('"limit" must be a number');
  return Math.min(Math.max(Math.floor(value), 1), MAX_ISSUE_LIMIT);
}

/** `assignee` accepts "me", an email, or an exact member name. Ambiguous names are refused with the candidates, never guessed at. */
async function resolveAssignee(tx: Tx, ctx: AuthContext, value: string): Promise<string> {
  if (value.toLowerCase() === "me") return ctx.userId;
  if (value.includes("@")) return resolveUserByEmail(tx, ctx.organizationId, value);

  const matches = await tx
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    .innerJoin(schema.member, eq(schema.member.userId, schema.user.id))
    .where(and(eq(schema.member.organizationId, ctx.organizationId), sql`lower(${schema.user.name}) = lower(${value})`));
  if (matches.length === 0) throw new NotFoundError(`No workspace member is named "${value}"`);
  if (matches.length > 1) {
    throw new ConflictError(
      `"${value}" matches several members. Ask again with their email: ${matches.map((m) => `${m.name} <${m.email}>`).join(", ")}`,
    );
  }
  return matches[0]!.id;
}

/** Sprint names are only unique per board, so a sprint reference always goes through the project it belongs to. */
async function resolveSprintOnProject(tx: Tx, projectId: string, sprintRef: string) {
  const [board] = await tx.select({ id: schema.board.id }).from(schema.board).where(eq(schema.board.projectId, projectId));
  if (!board) throw new NotFoundError("This project has no board");

  if (sprintRef.toLowerCase() === "active") {
    const active = await getActiveSprint(tx, board.id);
    if (!active) throw new NotFoundError("This project has no active sprint");
    return active;
  }

  const wanted = sprintRef.toLowerCase();
  const matches = (await listSprints(tx, board.id)).filter((s) => s.name.toLowerCase() === wanted);
  if (matches.length === 0) throw new NotFoundError(`No sprint named "${sprintRef}" in this project`);
  if (matches.length > 1) {
    throw new ConflictError(`More than one sprint is named "${sprintRef}": ${matches.map((s) => `${s.name} (${s.state})`).join(", ")}`);
  }
  return matches[0]!;
}

function issueSummary(f: IssueFacts, updatedAt: Date) {
  return {
    key: f.key,
    title: f.title,
    status: f.statusName,
    type: f.typeName,
    priority: f.priorityName,
    assignee: f.assigneeName,
    sprint: f.sprint?.name ?? null,
    labels: f.labels,
    updatedAt,
  };
}

async function userNames(tx: Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return names;
  const rows = await tx.select({ id: schema.user.id, name: schema.user.name }).from(schema.user).where(inArray(schema.user.id, unique));
  for (const r of rows) names.set(r.id, r.name);
  return names;
}

async function listProjectsTool(ctx: AuthContext) {
  return withAuthorizedTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ key: schema.project.key, name: schema.project.name, team: schema.team.name })
      .from(schema.project)
      .leftJoin(schema.team, eq(schema.team.id, schema.project.teamId))
      .where(eq(schema.project.organizationId, ctx.organizationId))
      .orderBy(asc(schema.project.key))
      .limit(100);
    return rows.map((r) => ({ key: r.key, name: r.name, team: r.team ?? null }));
  });
}

async function listIssuesTool(ctx: AuthContext, input: Record<string, unknown>) {
  const projectKey = readString(input, "projectKey");
  const status = readString(input, "status");
  const assignee = readString(input, "assignee");
  const sprint = readString(input, "sprint");
  const label = readString(input, "label");
  const includeArchived = readBoolean(input, "includeArchived") ?? false;
  const limit = readLimit(input);

  return withAuthorizedTenant(ctx, async (tx) => {
    const assigneeId = assignee ? await resolveAssignee(tx, ctx, assignee) : undefined;

    let sprintId: string | undefined;
    if (sprint) {
      if (!projectKey) throw new InvalidInputError('"sprint" needs a projectKey, because sprint names are only unique within a project');
      const project = await resolveProject(tx, ctx.organizationId, projectKey);
      sprintId = (await resolveSprintOnProject(tx, project.id, sprint)).id;
    }

    const { rows } = await queryIssues(tx, ctx.organizationId, { projectKey, statusName: status, assigneeId, sprintId, label, includeArchived, limit });
    const facts = await loadIssueFacts(tx, rows.map((r) => r.issue.id));
    const issues = rows.flatMap((r) => {
      const f = facts.get(r.issue.id);
      return f ? [issueSummary(f, r.issue.updatedAt)] : [];
    });
    return {
      count: issues.length,
      issues,
      ...(rows.length === limit ? { note: `Showing the first ${limit}. Narrow the filters to see others.` } : {}),
    };
  });
}

async function getIssueTool(ctx: AuthContext, input: Record<string, unknown>) {
  const key = requireString(input, "key");
  return withAuthorizedTenant(ctx, async (tx) => {
    const { issue } = await resolveIssue(tx, ctx.organizationId, key);
    const facts = (await loadIssueFacts(tx, [issue.id])).get(issue.id);
    if (!facts) throw new NotFoundError(`Issue ${key} not found`);

    const recent = (await listComments(tx, issue.id)).slice(-RECENT_COMMENTS);
    const authors = await userNames(tx, recent.map((c) => c.authorId));
    return {
      ...issueSummary(facts, issue.updatedAt),
      description: truncate(toPlainText(issue.descriptionJson), DESCRIPTION_CHARS),
      comments: recent.map((c) => ({
        author: c.authorId ? (authors.get(c.authorId) ?? null) : null,
        createdAt: c.createdAt,
        text: truncate(toPlainText(c.bodyJson), COMMENT_CHARS),
      })),
    };
  });
}

async function getSprintTool(ctx: AuthContext, input: Record<string, unknown>) {
  const projectKey = requireString(input, "projectKey");
  const sprintRef = requireString(input, "sprint");
  return withAuthorizedTenant(ctx, async (tx) => {
    const project = await resolveProject(tx, ctx.organizationId, projectKey);
    const sp = await resolveSprintOnProject(tx, project.id, sprintRef);
    return {
      name: sp.name,
      state: sp.state,
      goal: sp.goal,
      startAt: sp.startAt,
      endAt: sp.endAt,
      report: await getSprintReport(tx, sp.id),
    };
  });
}

async function searchWorkspaceTool(ctx: AuthContext, input: Record<string, unknown>) {
  const query = requireString(input, "query");
  return withAuthorizedTenant(ctx, async (tx) => {
    const embeddingCreds = await getEmbeddingCredentials(tx);
    if (!embeddingCreds) throw new EmbeddingNotConfiguredError();
    const enriched = await retrieveContext(tx, { userId: ctx.userId, organizationId: ctx.organizationId, embeddingCreds, question: query, limit: 8 });
    return enriched.map(({ candidate, enrichment }) => ({
      type: candidate.entityType,
      header: contextHeader(enrichment),
      excerpt: truncate(candidate.content, EXCERPT_CHARS),
    }));
  });
}

/** Errors whose message is written for the caller and safe to hand back to the model. Anything else is logged and reported generically. */
function isCallerError(err: unknown): err is Error {
  return (
    err instanceof NotFoundError ||
    err instanceof ConflictError ||
    err instanceof InvalidInputError ||
    err instanceof ForbiddenError ||
    err instanceof EmbeddingNotConfiguredError
  );
}

/**
 * Runs one model-requested tool call for the asking user. Never throws: a bad
 * argument, a missing or invisible record, or a permission failure all come
 * back as `{"error": "..."}` so the model can correct itself and answer
 * honestly. Each call opens its own short transaction (via the handlers), so
 * no transaction is held across the model's turns.
 */
export async function runAskTool(ctx: AuthContext, call: AiToolCall): Promise<string> {
  try {
    let value: unknown;
    switch (call.name) {
      case "list_projects":
        value = await listProjectsTool(ctx);
        break;
      case "list_issues":
        value = await listIssuesTool(ctx, call.input);
        break;
      case "get_issue":
        value = await getIssueTool(ctx, call.input);
        break;
      case "get_sprint":
        value = await getSprintTool(ctx, call.input);
        break;
      case "search_workspace":
        value = await searchWorkspaceTool(ctx, call.input);
        break;
      default:
        throw new InvalidInputError(`Unknown tool "${call.name}"`);
    }
    return encodeToolOutput(value);
  } catch (err) {
    if (isCallerError(err)) return JSON.stringify({ error: err.message });
    console.error(`[ask-tools] ${call.name} failed:`, err);
    return JSON.stringify({ error: "That lookup failed. Answer from what you already have, and say what you could not check." });
  }
}
