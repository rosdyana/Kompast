import { and, asc, eq, inArray, schema } from "@kompast/db";
import type { Tx } from "./types";
import { getSprint } from "./sprint";

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function eachDay(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const last = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cursor <= last) {
    days.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

interface DailyMember {
  issueId: string;
  storyPoints: number;
  category: "todo" | "in_progress" | "done";
}

/**
 * Reconstructs, day by day, which issues were on the sprint and what
 * status-category each was in — from sprint_issue's addedAt/removedAt plus
 * issue_history's status-change rows. There is no nightly sprint_snapshot
 * cron (apps/worker has no queue infra yet — see its own placeholder), so
 * this is what stands in for it: exact for scope membership, an
 * APPROXIMATION for status-as-of-day (an issue with no status-history row
 * before day D falls back to its current statusId, since createIssue
 * doesn't itself write a "status" history row for the initial status —
 * only "created"). Good enough for a trend chart; not a substitute for a
 * real point-in-time snapshot if that precision is ever needed.
 */
async function reconstructDaily(tx: Tx, sprintId: string): Promise<Map<string, DailyMember[]>> {
  const sprint = await getSprint(tx, sprintId);
  if (!sprint || !sprint.startAt) return new Map();
  const rangeEnd = sprint.endAt && sprint.endAt < new Date() ? sprint.endAt : new Date();

  const members = await tx.select().from(schema.sprintIssue).where(eq(schema.sprintIssue.sprintId, sprintId));
  if (members.length === 0) return new Map();

  const issueIds = [...new Set(members.map((m) => m.issueId))];
  const issues = await tx.select().from(schema.issue).where(inArray(schema.issue.id, issueIds));
  const issuesById = new Map(issues.map((i) => [i.id, i]));

  const statusChanges = await tx
    .select({ issueId: schema.issueHistory.issueId, toValue: schema.issueHistory.toValue, createdAt: schema.issueHistory.createdAt })
    .from(schema.issueHistory)
    .where(and(inArray(schema.issueHistory.issueId, issueIds), eq(schema.issueHistory.field, "status")))
    .orderBy(asc(schema.issueHistory.createdAt));
  const changesByIssue = new Map<string, { statusId: string; at: Date }[]>();
  for (const c of statusChanges) {
    if (!c.toValue) continue;
    const bucket = changesByIssue.get(c.issueId) ?? [];
    bucket.push({ statusId: c.toValue, at: c.createdAt });
    changesByIssue.set(c.issueId, bucket);
  }

  const projectId = issues[0]?.projectId;
  const statuses = projectId ? await tx.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, projectId)) : [];
  const categoryByStatus = new Map(statuses.map((s) => [s.id, s.category]));

  function statusAsOf(issueId: string, day: Date): string | undefined {
    const changes = changesByIssue.get(issueId);
    const priorChange = changes?.filter((c) => c.at <= day).at(-1);
    return priorChange?.statusId ?? issuesById.get(issueId)?.statusId;
  }

  const daily = new Map<string, DailyMember[]>();
  for (const day of eachDay(sprint.startAt, rangeEnd)) {
    const dayEnd = new Date(day.getTime() + 24 * 60 * 60 * 1000 - 1);
    const activeMembers = members.filter((m) => m.addedAt <= dayEnd && (!m.removedAt || m.removedAt > dayEnd));
    const rows: DailyMember[] = [];
    for (const m of activeMembers) {
      const issue = issuesById.get(m.issueId);
      if (!issue) continue;
      const statusId = statusAsOf(m.issueId, dayEnd);
      const category = (statusId ? categoryByStatus.get(statusId) : undefined) ?? "todo";
      rows.push({ issueId: m.issueId, storyPoints: issue.storyPoints ?? 0, category });
    }
    daily.set(dayKey(day), rows);
  }
  return daily;
}

export interface BurndownPoint {
  date: string;
  scopePoints: number;
  remainingPoints: number;
}

/** Points remaining per day — the classic burndown line. */
export async function getBurndown(tx: Tx, sprintId: string): Promise<BurndownPoint[]> {
  const daily = await reconstructDaily(tx, sprintId);
  return [...daily.entries()].map(([date, rows]) => ({
    date,
    scopePoints: rows.reduce((sum, r) => sum + r.storyPoints, 0),
    remainingPoints: rows.filter((r) => r.category !== "done").reduce((sum, r) => sum + r.storyPoints, 0),
  }));
}

export interface CumulativeFlowPoint {
  date: string;
  todo: number;
  inProgress: number;
  done: number;
}

/** Issue counts per status category per day — a cumulative flow diagram. */
export async function getCumulativeFlow(tx: Tx, sprintId: string): Promise<CumulativeFlowPoint[]> {
  const daily = await reconstructDaily(tx, sprintId);
  return [...daily.entries()].map(([date, rows]) => ({
    date,
    todo: rows.filter((r) => r.category === "todo").length,
    inProgress: rows.filter((r) => r.category === "in_progress").length,
    done: rows.filter((r) => r.category === "done").length,
  }));
}

export interface VelocityPoint {
  sprintId: string;
  sprintName: string;
  completedPoints: number;
}

/** Completed points from each of a board's past closed sprints, oldest first — the input to a velocity chart. */
export async function getVelocityHistory(tx: Tx, boardId: string, limit = 10): Promise<VelocityPoint[]> {
  const sprints = await tx
    .select({ id: schema.sprint.id, name: schema.sprint.name })
    .from(schema.sprint)
    .where(eq(schema.sprint.boardId, boardId))
    .orderBy(asc(schema.sprint.createdAt));
  if (sprints.length === 0) return [];

  const snapshots = await tx
    .select()
    .from(schema.sprintSnapshot)
    .where(inArray(schema.sprintSnapshot.sprintId, sprints.map((s) => s.id)));
  const completeBySprintId = new Map(snapshots.filter((s) => s.kind === "complete").map((s) => [s.sprintId, s]));

  return sprints
    .filter((s) => completeBySprintId.has(s.id))
    .map((s) => ({ sprintId: s.id, sprintName: s.name, completedPoints: completeBySprintId.get(s.id)!.completedPoints }))
    .slice(-limit);
}
