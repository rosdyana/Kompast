import { and, asc, eq, gte, inArray, notInArray, schema } from "@kompast/db";
import type { Tx } from "./types";
import { listSprintIssues } from "./sprint";
import { parseStandupSettings } from "./board";

type StatusCategory = "todo" | "in_progress" | "done";

export interface StandupActivityItem {
  issueId: string;
  kind: "created" | "status" | "commented" | "edited";
  /** for status: from/to status names + categories; for edited: field names */
  fromStatus?: { name: string; category: StatusCategory } | null;
  toStatus?: { name: string; category: StatusCategory } | null;
  fields?: string[];
  commentCount?: number;
  lastAt: Date;
}

/** Origins that must never surface in a person's standup: bulk imports and automation-driven edits aren't anyone's own work. */
const EXCLUDED_HISTORY_ORIGINS = ["import", "automation"];

const KIND_ORDER: Record<StandupActivityItem["kind"], number> = { status: 1, commented: 2, edited: 3, created: 4 };

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
  // A configured column with no statuses can't filter anything, so it isn't reported as a filter either.
  return { statusIds, columnNames: statusIds.size > 0 ? columns.map((c) => c.name) : [] };
}

/**
 * What each person did on this sprint's issues since `since`, grouped by
 * the user who did it. Status moves collapse to one item per (user, issue)
 * with the first from-status and the last to-status; other field edits
 * collapse to one `edited` item listing the field names; comments are
 * counted per author. Runs through the caller's tx, so RLS decides which
 * issues are visible at all.
 *
 * If the board has "Did" columns configured (board.standup_settings), only
 * status moves whose final to-status maps to one of those columns are kept
 * (edits, comments and creations are dropped); `didColumnNames` lists the
 * existing columns so the UI can say where the list came from. With no
 * usable columns configured, the full digest is returned and `didColumnNames`
 * is empty.
 */
export async function getStandupDigest(
  tx: Tx,
  input: { sprintId: string; since: Date },
): Promise<{ byUser: Record<string, StandupActivityItem[]>; didColumnNames: string[] }> {
  const didFilter = await resolveDidColumns(tx, input.sprintId);
  const issues = await listSprintIssues(tx, input.sprintId);
  if (issues.length === 0) return { byUser: {}, didColumnNames: didFilter.columnNames };
  const issueIds = issues.map((i) => i.id);
  const projectIds = [...new Set(issues.map((i) => i.projectId))];

  const [history, comments, statuses] = await Promise.all([
    tx
      .select()
      .from(schema.issueHistory)
      .where(
        and(
          inArray(schema.issueHistory.issueId, issueIds),
          gte(schema.issueHistory.createdAt, input.since),
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
          gte(schema.issueComment.createdAt, input.since),
          notInArray(schema.issueComment.origin, EXCLUDED_HISTORY_ORIGINS),
        ),
      )
      .orderBy(asc(schema.issueComment.createdAt)),
    tx.select().from(schema.workflowStatus).where(inArray(schema.workflowStatus.projectId, projectIds)),
  ]);

  const statusById = new Map(statuses.map((s) => [s.id, { name: s.name, category: s.category as StatusCategory }]));
  const resolveStatus = (statusId: string | null) => (statusId ? (statusById.get(statusId) ?? null) : null);

  // Build per-(user, issue, kind) accumulators, then flatten.
  interface Acc {
    userId: string;
    issueId: string;
    kind: StandupActivityItem["kind"];
    firstFromStatusId?: string | null;
    lastToStatusId?: string | null;
    fields: string[];
    commentCount: number;
    lastAt: Date;
  }
  const accs = new Map<string, Acc>();
  const accFor = (userId: string, issueId: string, kind: Acc["kind"], at: Date): Acc => {
    const key = `${userId}\u0000${issueId}\u0000${kind}`;
    let acc = accs.get(key);
    if (!acc) {
      acc = { userId, issueId, kind, fields: [], commentCount: 0, lastAt: at };
      accs.set(key, acc);
    }
    if (at > acc.lastAt) acc.lastAt = at;
    return acc;
  };

  for (const row of history) {
    if (!row.actorId) continue;
    if (row.field === "status") {
      const acc = accFor(row.actorId, row.issueId, "status", row.createdAt);
      // history is ordered ascending, so the first row sets the from-status and every later row updates to-status.
      if (acc.firstFromStatusId === undefined) acc.firstFromStatusId = row.fromValue;
      acc.lastToStatusId = row.toValue;
    } else if (row.field === "created") {
      accFor(row.actorId, row.issueId, "created", row.createdAt);
    } else {
      const acc = accFor(row.actorId, row.issueId, "edited", row.createdAt);
      if (!acc.fields.includes(row.field)) acc.fields.push(row.field);
    }
  }

  for (const c of comments) {
    const acc = accFor(c.authorId, c.issueId, "commented", c.createdAt);
    acc.commentCount += 1;
  }

  const byUser: Record<string, StandupActivityItem[]> = {};
  const filterByDid = didFilter.statusIds.size > 0;
  for (const acc of accs.values()) {
    if (filterByDid && (acc.kind !== "status" || !didFilter.statusIds.has(acc.lastToStatusId ?? ""))) continue;
    const item: StandupActivityItem = { issueId: acc.issueId, kind: acc.kind, lastAt: acc.lastAt };
    if (acc.kind === "status") {
      item.fromStatus = resolveStatus(acc.firstFromStatusId ?? null);
      item.toStatus = resolveStatus(acc.lastToStatusId ?? null);
    } else if (acc.kind === "edited") {
      item.fields = acc.fields;
    } else if (acc.kind === "commented") {
      item.commentCount = acc.commentCount;
    }
    (byUser[acc.userId] ??= []).push(item);
  }

  for (const items of Object.values(byUser)) {
    items.sort((a, b) => sortRank(a) - sortRank(b) || b.lastAt.getTime() - a.lastAt.getTime());
  }
  return { byUser, didColumnNames: filterByDid ? didFilter.columnNames : [] };
}

// ---------------------------------------------------------------------------
// Markdown rendering for the saved standup page.
// ---------------------------------------------------------------------------

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
