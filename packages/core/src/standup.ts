import { and, asc, eq, gte, inArray, isNull, notInArray, schema } from "@kompast/db";
import type { Tx } from "./types";
import { listSprintIssues } from "./sprint";
import { parseStandupSettings } from "./board";

type StatusCategory = "todo" | "in_progress" | "done";

export interface StandupActivityItem {
  issueId: string;
  kind: "created" | "status" | "commented" | "edited" | "logged";
  /** for status: from/to status names + categories; for edited: field keys (see STANDUP_EDIT_FIELDS) */
  fromStatus?: { name: string; category: StatusCategory } | null;
  toStatus?: { name: string; category: StatusCategory } | null;
  fields?: string[];
  commentCount?: number;
  /** for logged: total seconds of work logged in the window */
  loggedSeconds?: number;
  lastAt: Date;
}

/**
 * Label data for every issue a digest mentions, resolved server-side so the
 * standup never falls back to a raw issue id. The board only carries issues
 * whose status maps to a column, so the client can't be the source of truth.
 */
export interface StandupIssue {
  keySeq: number;
  projectKey: string;
  teamId: string | null;
  title: string;
  assigneeId: string | null;
  statusId: string;
  statusName: string;
  statusCategory: StatusCategory;
}

/** Origins that must never surface in a person's standup: bulk imports and automation-driven edits aren't anyone's own work. */
const EXCLUDED_HISTORY_ORIGINS = ["import", "automation"];

/**
 * issue_history fields that count as someone's own work in a standup. Anything
 * else (sprint membership, assignee, archive, jira.* import fields) is planning
 * or bookkeeping and is left out. The keys are stable; the UI translates them
 * (standup.field.<key>).
 */
export const STANDUP_EDIT_FIELDS = [
  "title",
  "description",
  "typeId",
  "priority",
  "storyPoints",
  "dueDate",
  "startDate",
  "epicId",
  "parentId",
  "labels",
  "estimateSeconds",
  "spentSeconds",
] as const;
const EDIT_FIELD_SET = new Set<string>(STANDUP_EDIT_FIELDS);

const KIND_ORDER: Record<StandupActivityItem["kind"], number> = { status: 1, logged: 2, commented: 3, edited: 4, created: 5 };

function sortRank(item: StandupActivityItem): number {
  if (item.kind === "status" && item.toStatus?.category === "done") return 0;
  return KIND_ORDER[item.kind];
}

/**
 * Resolves the board's configured "Did" columns (board.standup_settings) to
 * the workflow statuses they cover and their names. Stale ids (columns since
 * deleted) are dropped here; an empty result means "no filter" (default rule).
 */
async function resolveDidColumns(
  tx: Tx,
  sprintId: string,
): Promise<{ statusIds: Set<string>; columnNames: string[] }> {
  const [sprint] = await tx.select({ boardId: schema.sprint.boardId }).from(schema.sprint).where(eq(schema.sprint.id, sprintId)).limit(1);
  if (!sprint) return { statusIds: new Set(), columnNames: [] };
  const [board] = await tx
    .select({ standupSettings: schema.board.standupSettings })
    .from(schema.board)
    .where(eq(schema.board.id, sprint.boardId))
    .limit(1);
  const { didColumnIds } = parseStandupSettings(board?.standupSettings);
  if (didColumnIds.length === 0) return { statusIds: new Set(), columnNames: [] };

  const columns = await tx
    .select({ id: schema.boardColumn.id, name: schema.boardColumn.name })
    .from(schema.boardColumn)
    .where(and(eq(schema.boardColumn.boardId, sprint.boardId), inArray(schema.boardColumn.id, didColumnIds)))
    .orderBy(asc(schema.boardColumn.order));
  if (columns.length === 0) return { statusIds: new Set(), columnNames: [] };

  const columnStatuses = await tx
    .select({ workflowStatusId: schema.boardColumnStatus.workflowStatusId })
    .from(schema.boardColumnStatus)
    .where(inArray(schema.boardColumnStatus.boardColumnId, columns.map((c) => c.id)));
  const statusIds = new Set(columnStatuses.map((cs) => cs.workflowStatusId));
  return { statusIds, columnNames: statusIds.size > 0 ? columns.map((c) => c.name) : [] };
}

type StatusLookup = Map<string, { name: string; category: StatusCategory }>;

async function loadStatuses(tx: Tx, projectIds: string[]): Promise<StatusLookup> {
  if (projectIds.length === 0) return new Map();
  const statuses = await tx.select().from(schema.workflowStatus).where(inArray(schema.workflowStatus.projectId, projectIds));
  return new Map(statuses.map((s) => [s.id, { name: s.name, category: s.category as StatusCategory }]));
}

/** Labels for the given issues (non-archived, RLS-visible), keyed by issue id. */
async function loadIssueLabels(
  tx: Tx,
  issues: { id: string; projectId: string; keySeq: number; title: string; assigneeId: string | null; statusId: string }[],
  statusById: StatusLookup,
): Promise<Record<string, StandupIssue>> {
  const projectIds = [...new Set(issues.map((i) => i.projectId))];
  const projects =
    projectIds.length > 0
      ? await tx.select({ id: schema.project.id, key: schema.project.key, teamId: schema.project.teamId }).from(schema.project).where(inArray(schema.project.id, projectIds))
      : [];
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const out: Record<string, StandupIssue> = {};
  for (const issue of issues) {
    const project = projectById.get(issue.projectId);
    if (!project) continue;
    const status = statusById.get(issue.statusId);
    out[issue.id] = {
      keySeq: issue.keySeq,
      projectKey: project.key,
      teamId: project.teamId,
      title: issue.title,
      assigneeId: issue.assigneeId,
      statusId: issue.statusId,
      statusName: status?.name ?? "?",
      statusCategory: status?.category ?? "todo",
    };
  }
  return out;
}

/**
 * The shared activity fold behind both the sprint standup and the MCP
 * "standup-digest" prompt. Status moves collapse to one item per
 * (user, issue) with the first from-status and the last to-status (a move
 * that ends where it started is dropped); edits to STANDUP_EDIT_FIELDS
 * collapse to one `edited` item listing the field keys; comments are
 * counted and logged work summed per user. With `didStatusIds` non-empty,
 * only status moves ending in one of those statuses are kept.
 */
async function collectActivity(
  tx: Tx,
  input: { issueIds: string[]; since: Date; statusById: StatusLookup; didStatusIds?: Set<string> },
): Promise<Record<string, StandupActivityItem[]>> {
  const { issueIds, since, statusById } = input;
  if (issueIds.length === 0) return {};

  const [history, comments, worklogs] = await Promise.all([
    tx
      .select()
      .from(schema.issueHistory)
      .where(
        and(
          inArray(schema.issueHistory.issueId, issueIds),
          gte(schema.issueHistory.createdAt, since),
          notInArray(schema.issueHistory.origin, EXCLUDED_HISTORY_ORIGINS),
        ),
      )
      .orderBy(asc(schema.issueHistory.createdAt)),
    tx
      .select({ issueId: schema.issueComment.issueId, authorId: schema.issueComment.authorId, createdAt: schema.issueComment.createdAt })
      .from(schema.issueComment)
      .where(
        and(
          inArray(schema.issueComment.issueId, issueIds),
          gte(schema.issueComment.createdAt, since),
          notInArray(schema.issueComment.origin, EXCLUDED_HISTORY_ORIGINS),
        ),
      )
      .orderBy(asc(schema.issueComment.createdAt)),
    tx
      .select({ issueId: schema.worklog.issueId, userId: schema.worklog.userId, seconds: schema.worklog.seconds, loggedAt: schema.worklog.loggedAt })
      .from(schema.worklog)
      .where(and(inArray(schema.worklog.issueId, issueIds), gte(schema.worklog.loggedAt, since))),
  ]);

  const resolveStatus = (statusId: string | null) => (statusId ? (statusById.get(statusId) ?? null) : null);

  interface Acc {
    userId: string;
    issueId: string;
    kind: StandupActivityItem["kind"];
    firstFromStatusId?: string | null;
    lastToStatusId?: string | null;
    fields: string[];
    commentCount: number;
    loggedSeconds: number;
    lastAt: Date;
  }
  const accs = new Map<string, Acc>();
  const accFor = (userId: string, issueId: string, kind: Acc["kind"], at: Date): Acc => {
    const key = `${userId}\u0000${issueId}\u0000${kind}`;
    let acc = accs.get(key);
    if (!acc) {
      acc = { userId, issueId, kind, fields: [], commentCount: 0, loggedSeconds: 0, lastAt: at };
      accs.set(key, acc);
    }
    if (at > acc.lastAt) acc.lastAt = at;
    return acc;
  };

  for (const row of history) {
    if (!row.actorId) continue;
    if (row.field === "status") {
      const acc = accFor(row.actorId, row.issueId, "status", row.createdAt);
      if (acc.firstFromStatusId === undefined) acc.firstFromStatusId = row.fromValue;
      acc.lastToStatusId = row.toValue;
    } else if (row.field === "created") {
      accFor(row.actorId, row.issueId, "created", row.createdAt);
    } else if (EDIT_FIELD_SET.has(row.field)) {
      const acc = accFor(row.actorId, row.issueId, "edited", row.createdAt);
      if (!acc.fields.includes(row.field)) acc.fields.push(row.field);
    }
  }

  for (const c of comments) {
    const acc = accFor(c.authorId, c.issueId, "commented", c.createdAt);
    acc.commentCount += 1;
  }

  for (const w of worklogs) {
    if (w.seconds <= 0) continue;
    const acc = accFor(w.userId, w.issueId, "logged", w.loggedAt);
    acc.loggedSeconds += w.seconds;
  }

  const byUser: Record<string, StandupActivityItem[]> = {};
  const didStatusIds = input.didStatusIds ?? new Set<string>();
  const filterByDid = didStatusIds.size > 0;
  for (const acc of accs.values()) {
    if (filterByDid && (acc.kind !== "status" || !didStatusIds.has(acc.lastToStatusId ?? ""))) continue;
    // A round trip (A → B → A) isn't progress; drop it rather than print "A → A".
    if (acc.kind === "status" && acc.firstFromStatusId === acc.lastToStatusId) continue;
    const item: StandupActivityItem = { issueId: acc.issueId, kind: acc.kind, lastAt: acc.lastAt };
    if (acc.kind === "status") {
      item.fromStatus = resolveStatus(acc.firstFromStatusId ?? null);
      item.toStatus = resolveStatus(acc.lastToStatusId ?? null);
    } else if (acc.kind === "edited") {
      item.fields = acc.fields;
    } else if (acc.kind === "commented") {
      item.commentCount = acc.commentCount;
    } else if (acc.kind === "logged") {
      item.loggedSeconds = acc.loggedSeconds;
    }
    (byUser[acc.userId] ??= []).push(item);
  }

  for (const items of Object.values(byUser)) {
    items.sort((a, b) => sortRank(a) - sortRank(b) || b.lastAt.getTime() - a.lastAt.getTime());
  }
  return byUser;
}

/**
 * What each person did on this sprint's issues since `since`, grouped by
 * the user who did it (see collectActivity for how items collapse). Runs
 * through the caller's tx, so RLS decides which issues are visible at all.
 *
 * If the board has "Did" columns configured (board.standup_settings), only
 * status moves whose final to-status maps to one of those columns are kept
 * (edits, comments, logged work and creations are dropped); `didColumnNames`
 * lists the existing columns so the UI can say where the list came from.
 * With no usable columns configured, the full digest is returned and
 * `didColumnNames` is empty.
 *
 * `issues` labels every issue currently on the sprint, whether or not its
 * status maps to a board column, so the dialog's Today list, roster and
 * saved page never depend on what the board happens to render.
 */
export async function getStandupDigest(
  tx: Tx,
  input: { sprintId: string; since: Date },
): Promise<{ byUser: Record<string, StandupActivityItem[]>; didColumnNames: string[]; issues: Record<string, StandupIssue> }> {
  const didFilter = await resolveDidColumns(tx, input.sprintId);
  const sprintIssues = await listSprintIssues(tx, input.sprintId);
  if (sprintIssues.length === 0) return { byUser: {}, didColumnNames: didFilter.columnNames, issues: {} };

  const statusById = await loadStatuses(tx, [...new Set(sprintIssues.map((i) => i.projectId))]);
  const [byUser, issues] = await Promise.all([
    collectActivity(tx, { issueIds: sprintIssues.map((i) => i.id), since: input.since, statusById, didStatusIds: didFilter.statusIds }),
    loadIssueLabels(tx, sprintIssues, statusById),
  ]);
  return { byUser, didColumnNames: didFilter.statusIds.size > 0 ? didFilter.columnNames : [], issues };
}

/**
 * One person's standup across every project they can see: what they did
 * since `since` (same rules as getStandupDigest, minus the sprint and Did
 * column scoping) plus what they have in progress now. Backs the MCP
 * "standup-digest" prompt, so the prompt and the board's standup dialog
 * agree on what counts as work.
 */
export async function getMyStandupActivity(
  tx: Tx,
  input: { userId: string; since: Date },
): Promise<{ did: StandupActivityItem[]; inProgress: string[]; issues: Record<string, StandupIssue> }> {
  const { userId, since } = input;
  const [historyIds, commentIds, worklogIds, assigned] = await Promise.all([
    tx
      .selectDistinct({ issueId: schema.issueHistory.issueId })
      .from(schema.issueHistory)
      .where(and(eq(schema.issueHistory.actorId, userId), gte(schema.issueHistory.createdAt, since), notInArray(schema.issueHistory.origin, EXCLUDED_HISTORY_ORIGINS))),
    tx
      .selectDistinct({ issueId: schema.issueComment.issueId })
      .from(schema.issueComment)
      .where(and(eq(schema.issueComment.authorId, userId), gte(schema.issueComment.createdAt, since), notInArray(schema.issueComment.origin, EXCLUDED_HISTORY_ORIGINS))),
    tx
      .selectDistinct({ issueId: schema.worklog.issueId })
      .from(schema.worklog)
      .where(and(eq(schema.worklog.userId, userId), gte(schema.worklog.loggedAt, since))),
    tx
      .select({ id: schema.issue.id })
      .from(schema.issue)
      .innerJoin(schema.workflowStatus, eq(schema.workflowStatus.id, schema.issue.statusId))
      .where(and(eq(schema.issue.assigneeId, userId), eq(schema.workflowStatus.category, "in_progress"), isNull(schema.issue.archivedAt))),
  ]);

  const touchedIds = [...new Set([...historyIds, ...commentIds, ...worklogIds].map((r) => r.issueId))];
  const allIds = [...new Set([...touchedIds, ...assigned.map((r) => r.id)])];
  if (allIds.length === 0) return { did: [], inProgress: [], issues: {} };

  const rows = await tx
    .select({
      id: schema.issue.id,
      projectId: schema.issue.projectId,
      keySeq: schema.issue.keySeq,
      title: schema.issue.title,
      assigneeId: schema.issue.assigneeId,
      statusId: schema.issue.statusId,
    })
    .from(schema.issue)
    .where(and(inArray(schema.issue.id, allIds), isNull(schema.issue.archivedAt)));
  const statusById = await loadStatuses(tx, [...new Set(rows.map((r) => r.projectId))]);
  const visibleIds = new Set(rows.map((r) => r.id));

  const [byUser, issues] = await Promise.all([
    collectActivity(tx, { issueIds: touchedIds.filter((id) => visibleIds.has(id)), since, statusById }),
    loadIssueLabels(tx, rows, statusById),
  ]);
  return {
    did: byUser[userId] ?? [],
    inProgress: assigned.map((r) => r.id).filter((id) => visibleIds.has(id)),
    issues,
  };
}

/**
 * Backslash-escapes Markdown control characters in user-typed text so a
 * stray `#`, `[`, `*` or leading `- ` can't change the page's structure.
 * Applied per line, so the line-leading rules (`-`, `+`, `>`, `1.`) apply
 * to every line of a multi-line note, not only the first.
 */
export function escapeMd(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/[\\`*_[\]#<>|]/g, (c) => `\\${c}`)
        .replace(/^(\s*)([-+])/, "$1\\$2")
        .replace(/^(\s*)(\d+)\./, "$1$2\\."),
    )
    .join("\n");
}

export interface StandupRenderMember {
  name: string;
  did: string[];
  today: string[];
  blockers: string;
  notes: string;
  skipped: boolean;
}

function formatDuration(totalSec: number): string {
  const safe = Math.max(0, Math.round(totalSec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Non-empty trimmed lines of a free-text field, each escaped. */
function textBullets(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => escapeMd(line));
}

/** `items` must already be escaped (see textBullets / the did/today mapping below). */
function listSection(heading: string, items: string[]): string[] {
  const bullets = items.length > 0 ? items.map((item) => `- ${item}`) : ["- None"];
  return [`**${heading}**`, "", ...bullets, ""];
}

/**
 * Turns the standup dialog's state into a Markdown document for a new
 * child page. Every user-supplied string (issue titles in did/today,
 * blockers, notes, names) goes through escapeMd. The caller passes the
 * already-formatted "KEY-1 Title — From → To" strings; they are escaped
 * here, once, rather than trusted to be clean.
 */
export function renderStandupMarkdown(input: {
  date: string;
  members: StandupRenderMember[];
  durationSec: number;
}): string {
  const out: string[] = [];
  for (const member of input.members) {
    out.push(`## ${escapeMd(member.name)}`, "");
    if (member.skipped) {
      out.push("_Skipped._", "");
      // Anything typed for them before skipping is still worth keeping.
      const blockers = textBullets(member.blockers);
      if (blockers.length > 0) out.push(...listSection("Blockers", blockers));
      const notes = textBullets(member.notes);
      if (notes.length > 0) out.push(...listSection("Notes", notes));
      continue;
    }
    out.push(...listSection("Did", member.did.map((line) => escapeMd(line.trim()))));
    out.push(...listSection("Today", member.today.map((line) => escapeMd(line.trim()))));
    out.push(...listSection("Blockers", textBullets(member.blockers)));
    const notes = textBullets(member.notes);
    if (notes.length > 0) out.push(...listSection("Notes", notes));
  }
  out.push(`---`, "", `Standup ${escapeMd(input.date)} · total time ${formatDuration(input.durationSec)}`, "");
  return out.join("\n");
}
