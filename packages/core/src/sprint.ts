import { and, asc, desc, eq, inArray, isNull, schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

const CYCLE_DAYS: Record<string, number> = { "1w": 7, "2w": 14, "3w": 21, "4w": 28 };

export interface CreateSprintInput {
  organizationId: string;
  boardId: string;
  name: string;
  goal?: string;
  cycle?: "1w" | "2w" | "3w" | "4w" | "custom";
  startAt?: Date;
  endAt?: Date;
  capacityPoints?: number;
}

export async function createSprint(tx: Tx, input: CreateSprintInput) {
  const sprintId = id("sprint");
  await tx.insert(schema.sprint).values({
    id: sprintId,
    organizationId: input.organizationId,
    boardId: input.boardId,
    name: input.name,
    goal: input.goal,
    cycle: input.cycle ?? "2w",
    startAt: input.startAt,
    endAt: input.endAt,
    capacityPoints: input.capacityPoints,
  });
  return { sprintId };
}

export async function listSprints(tx: Tx, boardId: string) {
  return tx.select().from(schema.sprint).where(eq(schema.sprint.boardId, boardId)).orderBy(desc(schema.sprint.createdAt));
}

export async function getSprint(tx: Tx, sprintId: string) {
  const [sprint] = await tx.select().from(schema.sprint).where(eq(schema.sprint.id, sprintId));
  return sprint ?? null;
}

/** Issues with no current sprint — the backlog for a board's project. */
export async function listBacklogIssues(tx: Tx, projectId: string) {
  return tx
    .select()
    .from(schema.issue)
    .where(and(eq(schema.issue.projectId, projectId), isNull(schema.issue.sprintId)))
    .orderBy(asc(schema.issue.rank));
}

/**
 * Issues currently on a sprint (sprint_issue with no removedAt — i.e. not
 * carried away or pulled back to the backlog since).
 */
export async function listSprintIssues(tx: Tx, sprintId: string) {
  const members = await tx
    .select()
    .from(schema.sprintIssue)
    .where(and(eq(schema.sprintIssue.sprintId, sprintId), isNull(schema.sprintIssue.removedAt)));
  if (members.length === 0) return [];
  return tx
    .select()
    .from(schema.issue)
    .where(inArray(schema.issue.id, members.map((m) => m.issueId)))
    .orderBy(asc(schema.issue.rank));
}

/**
 * Adds an issue to a sprint (moving it out of the backlog, or off whatever
 * sprint it was on before). `plannedAtStart` is true only when the sprint
 * hasn't started yet — an issue added while a sprint is already active is
 * scope added mid-sprint, which velocity/scope-creep reporting need to be
 * able to tell apart from what was originally planned.
 */
export async function addIssueToSprint(tx: Tx, sprintId: string, issueId: string) {
  const sprint = await getSprint(tx, sprintId);
  if (!sprint) throw new Error(`Sprint ${sprintId} not found`);
  if (sprint.state === "closed") throw new Error("Cannot add an issue to a closed sprint");

  await tx
    .update(schema.sprintIssue)
    .set({ removedAt: new Date() })
    .where(and(eq(schema.sprintIssue.issueId, issueId), isNull(schema.sprintIssue.removedAt)));

  await tx.insert(schema.sprintIssue).values({
    id: id("sprintissue"),
    sprintId,
    issueId,
    plannedAtStart: sprint.state === "future",
  });
  await tx.update(schema.issue).set({ sprintId, updatedAt: new Date() }).where(eq(schema.issue.id, issueId));
}

/** Moves an issue back to the backlog (no sprint). */
export async function removeIssueFromSprint(tx: Tx, issueId: string) {
  await tx
    .update(schema.sprintIssue)
    .set({ removedAt: new Date() })
    .where(and(eq(schema.sprintIssue.issueId, issueId), isNull(schema.sprintIssue.removedAt)));
  await tx.update(schema.issue).set({ sprintId: null, updatedAt: new Date() }).where(eq(schema.issue.id, issueId));
}

async function scopeAndCompletion(tx: Tx, sprintId: string) {
  const issues = await listSprintIssues(tx, sprintId);
  if (issues.length === 0) return { scopeIssueCount: 0, scopePoints: 0, completedIssueCount: 0, completedPoints: 0, issues: [] as (typeof issues) };

  const statuses = await tx
    .select({ id: schema.workflowStatus.id, category: schema.workflowStatus.category })
    .from(schema.workflowStatus)
    .where(inArray(schema.workflowStatus.id, [...new Set(issues.map((i) => i.statusId))]));
  const doneStatusIds = new Set(statuses.filter((s) => s.category === "done").map((s) => s.id));

  const scopeIssueCount = issues.length;
  const scopePoints = issues.reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);
  const done = issues.filter((i) => doneStatusIds.has(i.statusId));
  const completedIssueCount = done.length;
  const completedPoints = done.reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);
  return { scopeIssueCount, scopePoints, completedIssueCount, completedPoints, issues };
}

export interface StartSprintInput {
  sprintId: string;
  actorId: string;
}

/**
 * Starts a sprint: enforces one active sprint per board (JIRA's own rule —
 * without it, burndown/velocity can't attribute an issue to a single
 * sprint), marks every issue currently attached as `plannedAtStart`
 * (anything present at start time IS the plan, regardless of when it was
 * added to the sprint before this moment), and takes the "start" snapshot
 * that scope-creep reporting compares later completion against.
 */
export async function startSprint(tx: Tx, input: StartSprintInput) {
  const sprint = await getSprint(tx, input.sprintId);
  if (!sprint) throw new Error(`Sprint ${input.sprintId} not found`);
  if (sprint.state !== "future") throw new Error(`Sprint is already ${sprint.state}`);

  const [alreadyActive] = await tx
    .select({ id: schema.sprint.id })
    .from(schema.sprint)
    .where(and(eq(schema.sprint.boardId, sprint.boardId), eq(schema.sprint.state, "active")));
  if (alreadyActive) throw new Error("This board already has an active sprint — complete it first");

  const startAt = sprint.startAt ?? new Date();
  const cycleDays = sprint.cycle === "custom" ? undefined : CYCLE_DAYS[sprint.cycle];
  const endAt = sprint.endAt ?? (cycleDays ? new Date(startAt.getTime() + cycleDays * 24 * 60 * 60 * 1000) : undefined);

  await tx
    .update(schema.sprintIssue)
    .set({ plannedAtStart: true })
    .where(and(eq(schema.sprintIssue.sprintId, input.sprintId), isNull(schema.sprintIssue.removedAt)));

  await tx.update(schema.sprint).set({ state: "active", startAt, endAt }).where(eq(schema.sprint.id, input.sprintId));

  const { scopeIssueCount, scopePoints, completedIssueCount, completedPoints } = await scopeAndCompletion(tx, input.sprintId);
  await tx.insert(schema.sprintSnapshot).values({
    id: id("sprintsnap"),
    sprintId: input.sprintId,
    kind: "start",
    scopeIssueCount,
    scopePoints,
    completedIssueCount,
    completedPoints,
  });
}

export interface CompleteSprintInput {
  sprintId: string;
  actorId: string;
  /** Carry not-done issues here instead of back to the backlog. */
  carryToSprintId?: string;
}

export interface CompleteSprintResult {
  completedIssueCount: number;
  completedPoints: number;
  carriedIssueCount: number;
  carriedPoints: number;
  velocity: number;
}

/**
 * Completes a sprint: whatever isn't in a "done"-category status is carried
 * over (to another sprint if given, else back to the backlog) rather than
 * silently staying attached to a now-closed sprint, then takes the
 * "complete" snapshot. Velocity is completed points — the plan's honest
 * definition, since a completed issue added mid-sprint still counts (it
 * really did get done), but scope-creep is visible separately via
 * `sprint_issue.plannedAtStart`.
 */
export async function completeSprint(tx: Tx, input: CompleteSprintInput): Promise<CompleteSprintResult> {
  const sprint = await getSprint(tx, input.sprintId);
  if (!sprint) throw new Error(`Sprint ${input.sprintId} not found`);
  if (sprint.state !== "active") throw new Error(`Sprint is not active (state: ${sprint.state})`);

  const { scopeIssueCount, scopePoints, completedIssueCount, completedPoints, issues } = await scopeAndCompletion(tx, input.sprintId);

  const statuses = await tx
    .select({ id: schema.workflowStatus.id, category: schema.workflowStatus.category })
    .from(schema.workflowStatus)
    .where(inArray(schema.workflowStatus.id, [...new Set(issues.map((i) => i.statusId))]));
  const doneStatusIds = new Set(statuses.filter((s) => s.category === "done").map((s) => s.id));
  const notDone = issues.filter((i) => !doneStatusIds.has(i.statusId));

  for (const issue of notDone) {
    if (input.carryToSprintId) {
      await addIssueToSprint(tx, input.carryToSprintId, issue.id);
    } else {
      await removeIssueFromSprint(tx, issue.id);
    }
  }

  await tx.update(schema.sprint).set({ state: "closed", endAt: new Date() }).where(eq(schema.sprint.id, input.sprintId));

  await tx.insert(schema.sprintSnapshot).values({
    id: id("sprintsnap"),
    sprintId: input.sprintId,
    kind: "complete",
    scopeIssueCount,
    scopePoints,
    completedIssueCount,
    completedPoints,
  });

  const carriedPoints = notDone.reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);
  return { completedIssueCount, completedPoints, carriedIssueCount: notDone.length, carriedPoints, velocity: completedPoints };
}

/** Live scope/completion for the sprint-review table — not a historical burndown curve (see packages/core/src/sprint.ts module docs). */
export async function getSprintReport(tx: Tx, sprintId: string) {
  const { scopeIssueCount, scopePoints, completedIssueCount, completedPoints } = await scopeAndCompletion(tx, sprintId);
  return {
    scopeIssueCount,
    scopePoints,
    completedIssueCount,
    completedPoints,
    remainingPoints: scopePoints - completedPoints,
  };
}
