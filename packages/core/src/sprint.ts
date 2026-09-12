import { and, asc, desc, eq, inArray, isNull, schema, sql } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";
import { getDefaultActiveStatusId } from "./board";
import { createPage, duplicatePage, updatePageMeta } from "./page";
import { rankBetween } from "./rank";

const CYCLE_DAYS: Record<string, number> = { "1w": 7, "2w": 14, "3w": 21, "4w": 28 };

export interface CreateSprintInput {
  organizationId: string;
  boardId: string;
  name?: string;
  number?: number;
  goal?: string;
  cycle?: "1w" | "2w" | "3w" | "4w" | "custom";
  startAt?: Date;
  endAt?: Date;
  capacityPoints?: number;
  /** When given, a linked minutes doc is created too — duplicated from the board's project's Sprint Minutes Template page if it has one, otherwise a blank page. Omit (as every pre-existing caller does) to skip that — sprint creation never depends on it. */
  actorUserId?: string;
}

async function nextSprintNumber(tx: Tx, boardId: string): Promise<number> {
  const [row] = await tx
    .select({ maxNumber: sql<number | null>`max(${schema.sprint.number})` })
    .from(schema.sprint)
    .where(eq(schema.sprint.boardId, boardId));
  return (row?.maxNumber ?? 0) + 1;
}

async function createLinkedMinutesPage(
  tx: Tx,
  input: { organizationId: string; boardId: string; sprintId: string; number: number; actorUserId: string },
): Promise<void> {
  const [board] = await tx.select({ projectId: schema.board.projectId }).from(schema.board).where(eq(schema.board.id, input.boardId));
  if (!board) return;

  const title = `Sprint ${input.number} — Sprint Action`;

  const [project] = await tx.select({ sprintMinutesTemplatePageId: schema.project.sprintMinutesTemplatePageId }).from(schema.project).where(eq(schema.project.id, board.projectId));
  const templateId = project?.sprintMinutesTemplatePageId;
  const [templateExists] = templateId
    ? await tx.select({ id: schema.page.id }).from(schema.page).where(eq(schema.page.id, templateId))
    : [];

  if (templateId && templateExists) {
    const minutesPage = await duplicatePage(tx, templateId, { actorUserId: input.actorUserId, sprintId: input.sprintId, titleSuffix: "" });
    await updatePageMeta(tx, minutesPage.id, { title });
    return;
  }

  // No template configured (or it's since been deleted) — still guarantee
  // every sprint gets a minutes doc; it just starts blank instead of
  // pre-seeded with Planning/Review/Retro headings. No BlockNote/Yjs
  // involved here (createPage never touches ydoc_state), so this keeps
  // packages/core free of that dependency, same as the template path above.
  await createPage(tx, {
    organizationId: input.organizationId,
    projectId: board.projectId,
    sprintId: input.sprintId,
    title,
    actorUserId: input.actorUserId,
  });
}

/**
 * Same shape as createLinkedMinutesPage, for the Sprint Retrospective doc —
 * except the created page is linked back via sprint.retroPageId (an update
 * on `sprint`) instead of page.sprintId, since page.sprintId already means
 * "this sprint's Sprint Action doc" and can't identify a second linked page
 * (see sprint.ts schema's retroPageId doc comment).
 */
async function createLinkedRetroPage(
  tx: Tx,
  input: { organizationId: string; boardId: string; sprintId: string; number: number; actorUserId: string },
): Promise<void> {
  const [board] = await tx.select({ projectId: schema.board.projectId }).from(schema.board).where(eq(schema.board.id, input.boardId));
  if (!board) return;

  const title = `Sprint ${input.number} — Retrospective`;

  const [project] = await tx.select({ sprintRetroTemplatePageId: schema.project.sprintRetroTemplatePageId }).from(schema.project).where(eq(schema.project.id, board.projectId));
  const templateId = project?.sprintRetroTemplatePageId;
  const [templateExists] = templateId
    ? await tx.select({ id: schema.page.id }).from(schema.page).where(eq(schema.page.id, templateId))
    : [];

  let retroPage;
  if (templateId && templateExists) {
    retroPage = await duplicatePage(tx, templateId, { actorUserId: input.actorUserId, projectId: board.projectId, titleSuffix: "" });
    await updatePageMeta(tx, retroPage.id, { title });
  } else {
    // No template configured (or it's since been deleted) — still guarantee
    // every sprint gets a retro doc; it just starts blank instead of
    // pre-seeded with Went Well/To Improve/Action Items headings.
    retroPage = await createPage(tx, {
      organizationId: input.organizationId,
      projectId: board.projectId,
      title,
      actorUserId: input.actorUserId,
    });
  }

  await tx.update(schema.sprint).set({ retroPageId: retroPage.id }).where(eq(schema.sprint.id, input.sprintId));
}

/**
 * `number` is the auto-incrementing per-board sprint number: pass it
 * explicitly only for a board's very first sprint (the setup wizard's
 * "continue numbering from JIRA" input) — every later sprint on that board
 * omits it and gets `max(existing) + 1` automatically. `name` defaults to
 * "Sprint {number}" (renamable afterward via `updateSprint`) so callers
 * never have to invent a name just to create a sprint.
 */
export async function createSprint(tx: Tx, input: CreateSprintInput) {
  const sprintId = id("sprint");
  const number = input.number ?? (await nextSprintNumber(tx, input.boardId));
  const name = input.name ?? `Sprint ${number}`;
  await tx.insert(schema.sprint).values({
    id: sprintId,
    organizationId: input.organizationId,
    boardId: input.boardId,
    number,
    name,
    goal: input.goal,
    cycle: input.cycle ?? "2w",
    startAt: input.startAt,
    endAt: input.endAt,
    capacityPoints: input.capacityPoints,
  });

  if (input.actorUserId) {
    await createLinkedMinutesPage(tx, {
      organizationId: input.organizationId,
      boardId: input.boardId,
      sprintId,
      number,
      actorUserId: input.actorUserId,
    });
    await createLinkedRetroPage(tx, {
      organizationId: input.organizationId,
      boardId: input.boardId,
      sprintId,
      number,
      actorUserId: input.actorUserId,
    });
  }

  return { sprintId, number };
}

export async function listSprints(tx: Tx, boardId: string) {
  return tx.select().from(schema.sprint).where(eq(schema.sprint.boardId, boardId)).orderBy(desc(schema.sprint.createdAt));
}

export async function getSprint(tx: Tx, sprintId: string) {
  const [sprint] = await tx.select().from(schema.sprint).where(eq(schema.sprint.id, sprintId));
  return sprint ?? null;
}

/** The sprint's linked Sprint Retrospective doc, if one's been created yet — null otherwise (see getOrCreateSprintRetroPage for the create-on-demand path). */
export async function getSprintRetroPage(tx: Tx, sprintId: string) {
  const sprint = await getSprint(tx, sprintId);
  if (!sprint?.retroPageId) return null;
  const [page] = await tx
    .select()
    .from(schema.page)
    .where(and(eq(schema.page.id, sprint.retroPageId), isNull(schema.page.archivedAt)));
  return page ?? null;
}

/**
 * Lazily backfills the retro page for a sprint created before this feature
 * existed (createSprint only wires one up for actor-initiated creation going
 * forward) — called when the Sprint Retrospective tab is opened, so no bulk
 * migration script is needed for already-existing sprints.
 */
export async function getOrCreateSprintRetroPage(tx: Tx, sprintId: string, actorUserId: string) {
  const existing = await getSprintRetroPage(tx, sprintId);
  if (existing) return existing;

  const sprint = await getSprint(tx, sprintId);
  if (!sprint) throw new Error(`Sprint ${sprintId} not found`);

  await createLinkedRetroPage(tx, {
    organizationId: sprint.organizationId,
    boardId: sprint.boardId,
    sprintId: sprint.id,
    number: sprint.number,
    actorUserId,
  });

  const page = await getSprintRetroPage(tx, sprintId);
  if (!page) throw new Error(`Failed to create retrospective page for sprint ${sprintId}`);
  return page;
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
  const sprintRankByIssueId = new Map(members.map((m) => [m.issueId, m.rank]));
  const issues = await tx
    .select()
    .from(schema.issue)
    .where(inArray(schema.issue.id, members.map((m) => m.issueId)))
    .orderBy(asc(schema.issue.rank));
  // sprintRank is this sprint's own manual-reorder rank (sprint_issue.rank),
  // distinct from issue.rank — see reorderSprintIssue/the schema doc comment
  // on sprint_issue.rank. Null for rows created before drag-reorder shipped,
  // until the backfill script or a first manual reorder sets it.
  return issues.map((issue) => ({ ...issue, sprintRank: sprintRankByIssueId.get(issue.id) ?? null }));
}

export interface ReorderSprintIssueInput {
  sprintId: string;
  issueId: string;
  beforeIssueId?: string;
  afterIssueId?: string;
}

/**
 * Manual drag-and-drop reorder for the Sprint Review table — writes
 * sprint_issue.rank, scoped to this sprint, never issue.rank (see
 * sprint_issue's schema doc comment: dragging a row here must never
 * reorder that issue on the backlog/kanban board). Same
 * neighbor-rank-lookup + single-row-write pattern as moveIssue
 * (packages/core/src/issue.ts).
 */
export async function reorderSprintIssue(tx: Tx, input: ReorderSprintIssueInput): Promise<void> {
  const [current] = await tx
    .select({ id: schema.sprintIssue.id })
    .from(schema.sprintIssue)
    .where(and(eq(schema.sprintIssue.sprintId, input.sprintId), eq(schema.sprintIssue.issueId, input.issueId), isNull(schema.sprintIssue.removedAt)));
  if (!current) throw new Error(`Issue ${input.issueId} is not currently on sprint ${input.sprintId}`);

  const neighborRank = (neighborIssueId: string | undefined) =>
    neighborIssueId
      ? tx
          .select({ rank: schema.sprintIssue.rank })
          .from(schema.sprintIssue)
          .where(and(eq(schema.sprintIssue.sprintId, input.sprintId), eq(schema.sprintIssue.issueId, neighborIssueId), isNull(schema.sprintIssue.removedAt)))
      : Promise.resolve([]);

  const [beforeRow, afterRow] = await Promise.all([neighborRank(input.beforeIssueId), neighborRank(input.afterIssueId)]);
  const newRank = rankBetween(beforeRow[0]?.rank ?? null, afterRow[0]?.rank ?? null);
  await tx.update(schema.sprintIssue).set({ rank: newRank }).where(eq(schema.sprintIssue.id, current.id));
}

/**
 * Optional attribution for addIssueToSprint/removeIssueFromSprint — undefined
 * (every pre-existing caller before the Activity tab needed this) means
 * "don't write an issue_history row," matching the original behavior;
 * passing it logs a "sprint" field change so the Activity tab can show it.
 */
export interface SprintMembershipActor {
  actorId: string;
  origin?: "user" | "automation" | "mcp" | "api" | "import";
  originClient?: string;
}

/**
 * Adds an issue to a sprint (moving it out of the backlog, or off whatever
 * sprint it was on before). `plannedAtStart` is true only when the sprint
 * hasn't started yet — an issue added while a sprint is already active is
 * scope added mid-sprint, which velocity/scope-creep reporting need to be
 * able to tell apart from what was originally planned.
 *
 * An issue still sitting in the board's Backlog column when it's added is
 * also transitioned to the board's default active status (see
 * getDefaultActiveStatusId) — otherwise it would join the sprint but never
 * appear on the Board tab, which filters the Backlog column out entirely.
 * An issue already past Backlog (In Progress, Done, ...) is left alone.
 */
export async function addIssueToSprint(tx: Tx, sprintId: string, issueId: string, actor?: SprintMembershipActor) {
  const sprint = await getSprint(tx, sprintId);
  if (!sprint) throw new Error(`Sprint ${sprintId} not found`);
  if (sprint.state === "closed") throw new Error("Cannot add an issue to a closed sprint");

  const [before] = await tx.select({ sprintId: schema.issue.sprintId }).from(schema.issue).where(eq(schema.issue.id, issueId));

  await tx
    .update(schema.sprintIssue)
    .set({ removedAt: new Date() })
    .where(and(eq(schema.sprintIssue.issueId, issueId), isNull(schema.sprintIssue.removedAt)));

  const [lastRanked] = await tx
    .select({ rank: schema.sprintIssue.rank })
    .from(schema.sprintIssue)
    .where(and(eq(schema.sprintIssue.sprintId, sprintId), isNull(schema.sprintIssue.removedAt)))
    .orderBy(desc(schema.sprintIssue.rank))
    .limit(1);

  await tx.insert(schema.sprintIssue).values({
    id: id("sprintissue"),
    sprintId,
    issueId,
    plannedAtStart: sprint.state === "future",
    // Appends to the end of this sprint's manual review order — see
    // reorderSprintIssue/sprint_issue.rank's doc comment.
    rank: rankBetween(lastRanked?.rank ?? null, null),
  });

  const updateValues: { sprintId: string; updatedAt: Date; statusId?: string } = { sprintId, updatedAt: new Date() };
  const [current] = await tx.select({ statusId: schema.issue.statusId }).from(schema.issue).where(eq(schema.issue.id, issueId));
  const backlogStatusRows = await tx
    .select({ workflowStatusId: schema.boardColumnStatus.workflowStatusId })
    .from(schema.boardColumnStatus)
    .innerJoin(schema.boardColumn, eq(schema.boardColumn.id, schema.boardColumnStatus.boardColumnId))
    .where(and(eq(schema.boardColumn.boardId, sprint.boardId), eq(schema.boardColumn.isBacklog, true)));
  const isCurrentlyBacklog = current && backlogStatusRows.some((r) => r.workflowStatusId === current.statusId);
  if (isCurrentlyBacklog) {
    const targetStatusId = await getDefaultActiveStatusId(tx, sprint.boardId);
    if (targetStatusId) updateValues.statusId = targetStatusId;
  }

  await tx.update(schema.issue).set(updateValues).where(eq(schema.issue.id, issueId));

  if (actor && before?.sprintId !== sprintId) {
    await tx.insert(schema.issueHistory).values({
      id: id("hist"),
      issueId,
      actorId: actor.actorId,
      origin: actor.origin ?? "user",
      originClient: actor.originClient,
      field: "sprint",
      fromValue: before?.sprintId ?? null,
      toValue: sprintId,
    });
  }
}

/** Moves an issue back to the backlog (no sprint). */
export async function removeIssueFromSprint(tx: Tx, issueId: string, actor?: SprintMembershipActor) {
  const [before] = await tx.select({ sprintId: schema.issue.sprintId }).from(schema.issue).where(eq(schema.issue.id, issueId));

  await tx
    .update(schema.sprintIssue)
    .set({ removedAt: new Date() })
    .where(and(eq(schema.sprintIssue.issueId, issueId), isNull(schema.sprintIssue.removedAt)));
  await tx.update(schema.issue).set({ sprintId: null, updatedAt: new Date() }).where(eq(schema.issue.id, issueId));

  if (actor && before?.sprintId) {
    await tx.insert(schema.issueHistory).values({
      id: id("hist"),
      issueId,
      actorId: actor.actorId,
      origin: actor.origin ?? "user",
      originClient: actor.originClient,
      field: "sprint",
      fromValue: before.sprintId,
      toValue: null,
    });
  }
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

  const actor: SprintMembershipActor = { actorId: input.actorId };
  for (const issue of notDone) {
    if (input.carryToSprintId) {
      await addIssueToSprint(tx, input.carryToSprintId, issue.id, actor);
    } else {
      await removeIssueFromSprint(tx, issue.id, actor);
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

export interface UpdateSprintInput {
  sprintId: string;
  name: string;
}

/** Renaming is the only sprint edit exposed so far — number/dates/cycle are fixed at creation. */
export async function updateSprint(tx: Tx, input: UpdateSprintInput): Promise<void> {
  const trimmed = input.name.trim();
  if (!trimmed) throw new Error("Sprint name cannot be empty");
  await tx.update(schema.sprint).set({ name: trimmed }).where(eq(schema.sprint.id, input.sprintId));
}
