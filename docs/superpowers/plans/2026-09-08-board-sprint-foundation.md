# Board/Sprint Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every board always has at least one sprint (auto-numbered, JIRA-continuation-friendly), with a Jira-style Backlog tab for planning distinct from the Backlog column, a sprint-scoped Board tab, and a guard so a board can never lose its last Backlog/In-Progress/Done column.

**Architecture:** A new `sprint.number` column (auto-incrementing per board, seeded once from a setup wizard) replaces sprint's free-text-only identity. `board.type` (kanban/scrum) is dropped since every board now behaves identically. The existing project page's combined "Sprint" tab is split: a new **Backlog** tab hosts sprint picking/creation/renaming and the Jira-style active/future/backlog sections; the existing **Board** tab is narrowed to the active sprint's non-backlog columns; a **setup wizard** gates both tabs until a board has at least one sprint. `deleteBoardColumn` gains a guard so the last column covering the `in_progress` or `done` category can't be deleted (the `todo`/Backlog case is already guarded today).

**Tech Stack:** Drizzle ORM/Postgres (packages/db), plain TS core logic (packages/core), TanStack Start server functions + React/Tailwind UI (apps/web), Vitest against real Postgres (repo convention — no DB mocking).

**Spec:** `docs/superpowers/specs/2026-09-08-board-sprint-foundation-design.md`

## Global Constraints

- No mocked Postgres anywhere — every `packages/core` test runs against a real database (`DATABASE_ADMIN_URL`/`DATABASE_URL` must be exported into the shell first: `set -a && source <your-env-file> && set +a`).
- Every mutation goes through `packages/core`, inside `withAuthorizedTenant` — never a bare `db` import (see root `CLAUDE.md`, "Tenant isolation").
- `pnpm --filter @kompast/db migrate` must be run at least once (after generating the new migration) before any test that touches the new `sprint.number` column or the dropped `board.type` column.
- This plan touches `apps/web` (a deployable service per root `CLAUDE.md`) — the final task requires a real `docker build`/`docker run`, not just `pnpm build`/`vitest`.
- Do not commit or push without the user's explicit go-ahead on that specific change (session-level instruction) — commit locally on the feature branch as each task completes (per "frequent commits" below), but do not push the branch or merge to `main` without asking first.

---

## Task 1: Schema — `sprint.number`, drop `board.type`, migration + backfill

**Files:**
- Modify: `packages/db/src/schema/sprint.ts`
- Modify: `packages/db/src/schema/board.ts`
- Create: `packages/db/drizzle/00XX_<generated-name>.sql` (exact name assigned by `drizzle-kit generate` — replace its generated contents per Step 3 below)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `schema.sprint.number` (integer, not null, unique per `boardId`), `schema.sprint` no longer has `type` on `schema.board`. Every later task in this plan assumes these exist.

- [ ] **Step 1: Edit the schema files**

In `packages/db/src/schema/sprint.ts`, change the import line and add the `number` column + a unique index:

```ts
import { pgTable, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
```

```ts
export const sprint = pgTable(
  "sprint",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    boardId: text("board_id")
      .notNull()
      .references(() => board.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    name: text("name").notNull(),
    goal: text("goal"),
    state: text("state", { enum: ["future", "active", "closed"] }).notNull().default("future"),
    cycle: text("cycle", { enum: ["1w", "2w", "3w", "4w", "custom"] }).notNull().default("2w"),
    startAt: timestamp("start_at"),
    endAt: timestamp("end_at"),
    capacityPoints: integer("capacity_points"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("sprint_board_idx").on(t.boardId),
    index("sprint_org_idx").on(t.organizationId),
    uniqueIndex("sprint_board_number_uq").on(t.boardId, t.number),
  ],
);
```

In `packages/db/src/schema/board.ts`, remove the `type` field entirely:

```ts
export const board = pgTable("board", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  swimlaneBy: text("swimlane_by", { enum: ["none", "assignee", "epic", "priority"] })
    .notNull()
    .default("none"),
  /** { search, labels, assignees, ... } saved as the default quick-filter set. */
  quickFilters: jsonb("quick_filters").$type<Json>(),
  /** { cycle: '1w'|'2w'|'3w'|'4w'|'custom', customDays, startWeekday, autoCreateNext, carryOverPolicy } — consumed starting P4. */
  sprintDefaults: jsonb("sprint_defaults").$type<Json>(),
});
```

- [ ] **Step 2: Generate the migration**

Run:

```bash
pnpm --filter @kompast/db generate
```

This creates a new file `packages/db/drizzle/00XX_<random-name>.sql` (drizzle-kit picks the next number and a random slug) and updates `packages/db/drizzle/meta/`. If the CLI prompts interactively about the new `number` column (asking for a default value since the table may already have rows), answer `0` — its actual generated SQL for that column will be fully replaced in the next step regardless.

- [ ] **Step 3: Replace the generated migration's SQL with the hand-written version**

Open the new `packages/db/drizzle/00XX_<random-name>.sql` file and replace its **entire contents** with exactly this (adds the column nullable first, backfills sequential numbers per board ordered by creation time, then enforces `NOT NULL` + uniqueness, then drops `board.type`):

```sql
ALTER TABLE "sprint" ADD COLUMN "number" integer;
--> statement-breakpoint
UPDATE "sprint" AS s
SET "number" = numbered.rn
FROM (
	SELECT "id", ROW_NUMBER() OVER (PARTITION BY "board_id" ORDER BY "created_at") AS rn
	FROM "sprint"
) AS numbered
WHERE s."id" = numbered."id";
--> statement-breakpoint
ALTER TABLE "sprint" ALTER COLUMN "number" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "sprint_board_number_uq" ON "sprint" USING btree ("board_id","number");
--> statement-breakpoint
ALTER TABLE "board" DROP COLUMN "type";
```

Do not touch `packages/db/drizzle/meta/` — it already reflects the target schema from Step 2 regardless of what SQL you put in the file.

- [ ] **Step 4: Apply the migration**

Make sure your env vars are exported first (`set -a && source <your-env-file> && set +a`), then run:

```bash
pnpm --filter @kompast/db migrate
```

Expected: `Migrations applied.` with no errors, and no pre-existing sprint rows lost their board association.

**Note on backfill verification:** there is no automated test for the backfill `UPDATE` itself — a fresh dev/CI Postgres has no pre-existing `sprint` rows for it to act on, so there's nothing realistic to assert against without fabricating a pre-migration data shape. If this database already has sprint rows from earlier manual testing, spot-check them after this step: `SELECT board_id, number, name, created_at FROM sprint ORDER BY board_id, number;` should show `1, 2, 3…` per `board_id` in `created_at` order, with no gaps or duplicates.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/sprint.ts packages/db/src/schema/board.ts packages/db/drizzle/
git commit -m "feat(db): add sprint.number, drop board.type"
```

---

## Task 2: `createSprint` auto-numbering + `updateSprint` (rename)

**Files:**
- Modify: `packages/core/src/sprint.ts`
- Modify: `packages/core/src/__tests__/sprint.test.ts`

**Interfaces:**
- Consumes: `schema.sprint.number` (Task 1).
- Produces: `createSprint(tx, input: CreateSprintInput)` now returns `{ sprintId: string; number: number }` and accepts optional `name`/`number`; `updateSprint(tx, input: { sprintId: string; name: string })` — new export, used by Task 5's `updateSprintFn` and Task 7's rename UI.

- [ ] **Step 1: Write the failing tests**

Add these `it(...)` blocks inside the existing `describe("sprint lifecycle", ...)` in `packages/core/src/__tests__/sprint.test.ts`, right after the `"creates a sprint in the future state and lists it for its board"` test:

```ts
  it("auto-numbers sprints sequentially per board, independent of other boards", async () => {
    const { boardId } = await seedProject();
    const { sprintId: s1, number: n1 } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint A" }));
    const { sprintId: s2, number: n2 } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint B" }));
    expect(n1).toBe(1);
    expect(n2).toBe(2);
    expect(s1).not.toBe(s2);

    const { boardId: otherBoardId } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: "spr2", name: "Sprint Test 2", actorUserId: userId }),
    );
    const { number: otherN1 } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId: otherBoardId, name: "Other Sprint" }));
    expect(otherN1).toBe(1);
  });

  it("an explicit starting number seeds the sequence for later auto-numbered sprints", async () => {
    const { boardId } = await seedProject();
    const { number: first } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, number: 42 }));
    const { number: second } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId }));
    expect(first).toBe(42);
    expect(second).toBe(43);
  });

  it("defaults a sprint's name to 'Sprint {number}' when no name is given", async () => {
    const { boardId } = await seedProject();
    const { sprintId, number } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId }));
    const sprint = await withAuthorizedTenant(ctx, (tx) => getSprint(tx, sprintId));
    expect(sprint!.name).toBe(`Sprint ${number}`);
  });

  it("rejects an explicit number that collides with an existing sprint on the same board", async () => {
    const { boardId } = await seedProject();
    await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, number: 1 }));
    await expect(withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, number: 1 }))).rejects.toThrow();
  });

  it("updateSprint renames a sprint, and rejects an empty name", async () => {
    const { boardId } = await seedProject();
    const { sprintId } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Original" }));

    await withAuthorizedTenant(ctx, (tx) => updateSprint(tx, { sprintId, name: "Renamed" }));
    const sprint = await withAuthorizedTenant(ctx, (tx) => getSprint(tx, sprintId));
    expect(sprint!.name).toBe("Renamed");

    await expect(withAuthorizedTenant(ctx, (tx) => updateSprint(tx, { sprintId, name: "   " }))).rejects.toThrow(/empty/i);
  });
```

Add `updateSprint` to the existing import block from `../sprint` at the top of the file:

```ts
import {
  createSprint,
  listSprints,
  getSprint,
  listBacklogIssues,
  listSprintIssues,
  addIssueToSprint,
  removeIssueFromSprint,
  startSprint,
  completeSprint,
  getSprintReport,
  updateSprint,
} from "../sprint";
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @kompast/core exec vitest run src/__tests__/sprint.test.ts`
Expected: FAIL — `number` doesn't exist on `CreateSprintInput`, `updateSprint` is not exported.

- [ ] **Step 3: Implement**

In `packages/core/src/sprint.ts`, change the import line to add `sql`:

```ts
import { and, asc, desc, eq, inArray, isNull, schema, sql } from "@kompast/db";
```

Replace the `CreateSprintInput` interface and `createSprint` function with:

```ts
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
}

async function nextSprintNumber(tx: Tx, boardId: string): Promise<number> {
  const [row] = await tx
    .select({ maxNumber: sql<number | null>`max(${schema.sprint.number})` })
    .from(schema.sprint)
    .where(eq(schema.sprint.boardId, boardId));
  return (row?.maxNumber ?? 0) + 1;
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
  return { sprintId, number };
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
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @kompast/core exec vitest run src/__tests__/sprint.test.ts`
Expected: PASS — all tests in the file, including the pre-existing ones (they never pass `number`, so they exercise the auto-increment path).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sprint.ts packages/core/src/__tests__/sprint.test.ts
git commit -m "feat(core): auto-number sprints per board, add updateSprint rename"
```

---

## Task 3: Required-columns guard on `deleteBoardColumn`

**Files:**
- Modify: `packages/core/src/board.ts`
- Modify: `packages/core/src/__tests__/board-settings.test.ts`

**Interfaces:**
- Consumes: `schema.workflowStatus.category`, `schema.boardColumnStatus` (both pre-existing, unchanged).
- Produces: `deleteBoardColumn` now additionally throws when deletion would leave the board with zero columns covering the `in_progress` or `done` category (the `todo`/Backlog case was already guarded before this task).

- [ ] **Step 1: Write the failing test**

Add this `it(...)` inside `describe("board column settings", ...)` in `packages/core/src/__tests__/board-settings.test.ts`, after the existing `"deleteBoardColumn reassigns tickets..."` test:

```ts
  it("deleteBoardColumn refuses to remove the last column covering the in_progress or done category", async () => {
    const { boardId } = await seedProject("BSF");
    const [project] = await admin.select().from(schema.project).where(eq(schema.project.key, "BSF"));
    const columns = await admin.select().from(schema.boardColumn).where(eq(schema.boardColumn.boardId, boardId)).orderBy(asc(schema.boardColumn.order));
    // DEFAULT_STATUSES seeds: Backlog(todo), To Do(todo), In Progress(in_progress), In Review(in_progress), Done(done)
    const inProgress = columns.find((c) => c.name === "In Progress")!;
    const inReview = columns.find((c) => c.name === "In Review")!;
    const done = columns.find((c) => c.name === "Done")!;

    // Two in_progress-category columns exist — deleting one is fine.
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => deleteBoardColumn(tx, { projectId: project!.id, columnId: inProgress.id }));

    // Now only "In Review" covers in_progress — deleting it must be refused.
    await expect(
      withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => deleteBoardColumn(tx, { projectId: project!.id, columnId: inReview.id })),
    ).rejects.toThrow(/in_progress/);

    // "Done" is the only done-category column — deleting it must be refused too.
    await expect(
      withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => deleteBoardColumn(tx, { projectId: project!.id, columnId: done.id })),
    ).rejects.toThrow(/done/);
  });
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @kompast/core exec vitest run src/__tests__/board-settings.test.ts`
Expected: FAIL — deleting "In Review" and "Done" currently succeeds with no guard.

- [ ] **Step 3: Implement**

In `packages/core/src/board.ts`, change the import line:

```ts
import { and, asc, eq, inArray, ne, schema } from "@kompast/db";
```

Add this constant above `deleteBoardColumn`, and insert the new guard block into the function right after the existing `isBacklog` check (before the backlog-repoint logic):

```ts
const REQUIRED_CATEGORIES = new Set(["in_progress", "done"]);

export async function deleteBoardColumn(tx: Tx, input: DeleteBoardColumnInput): Promise<void> {
  const [column] = await tx
    .select({ id: schema.boardColumn.id, boardId: schema.boardColumn.boardId, isBacklog: schema.boardColumn.isBacklog })
    .from(schema.boardColumn)
    .innerJoin(schema.board, eq(schema.board.id, schema.boardColumn.boardId))
    .where(and(eq(schema.boardColumn.id, input.columnId), eq(schema.board.projectId, input.projectId)))
    .limit(1);
  if (!column) throw new Error(`Column ${input.columnId} not found in project ${input.projectId}`);
  if (column.isBacklog) throw new Error("The Backlog column cannot be deleted");

  const thisColumnStatusRows = await tx
    .select({ workflowStatusId: schema.boardColumnStatus.workflowStatusId })
    .from(schema.boardColumnStatus)
    .where(eq(schema.boardColumnStatus.boardColumnId, input.columnId));

  if (thisColumnStatusRows.length > 0) {
    const thisStatuses = await tx
      .select({ category: schema.workflowStatus.category })
      .from(schema.workflowStatus)
      .where(inArray(schema.workflowStatus.id, thisColumnStatusRows.map((r) => r.workflowStatusId)));
    const categoriesHere = [...new Set(thisStatuses.map((s) => s.category))].filter((c) => REQUIRED_CATEGORIES.has(c));

    if (categoriesHere.length > 0) {
      // Backlog is deliberately excluded from "other" coverage: it's the
      // fallback/orphan bucket for the todo category (this same function's
      // own reassignment step folds a deleted column's statuses onto it),
      // and must never silently satisfy a DIFFERENT required category's
      // presence — the user asked for backlog/in_progress/done as three
      // distinct, always-present columns, not one that can absorb another.
      const otherColumnStatusRows = await tx
        .select({ workflowStatusId: schema.boardColumnStatus.workflowStatusId })
        .from(schema.boardColumnStatus)
        .innerJoin(schema.boardColumn, eq(schema.boardColumn.id, schema.boardColumnStatus.boardColumnId))
        .where(
          and(
            eq(schema.boardColumn.boardId, column.boardId),
            ne(schema.boardColumnStatus.boardColumnId, input.columnId),
            eq(schema.boardColumn.isBacklog, false),
          ),
        );
      const otherCategories =
        otherColumnStatusRows.length > 0
          ? new Set(
              (
                await tx
                  .select({ category: schema.workflowStatus.category })
                  .from(schema.workflowStatus)
                  .where(inArray(schema.workflowStatus.id, otherColumnStatusRows.map((r) => r.workflowStatusId)))
              ).map((s) => s.category),
            )
          : new Set<string>();

      for (const category of categoriesHere) {
        if (!otherCategories.has(category)) {
          throw new Error(`Cannot delete the last column mapped to the "${category}" category`);
        }
      }
    }
  }

  const [backlog] = await tx
    .select({ id: schema.boardColumn.id })
    .from(schema.boardColumn)
    .where(and(eq(schema.boardColumn.boardId, column.boardId), eq(schema.boardColumn.isBacklog, true)))
    .limit(1);
  if (!backlog) throw new Error(`Board ${column.boardId} has no Backlog column`);

  await tx
    .update(schema.boardColumnStatus)
    .set({ boardColumnId: backlog.id })
    .where(eq(schema.boardColumnStatus.boardColumnId, input.columnId));
  await tx.delete(schema.boardColumn).where(eq(schema.boardColumn.id, input.columnId));
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @kompast/core exec vitest run src/__tests__/board-settings.test.ts`
Expected: PASS — including the pre-existing tests (deleting "To Do" still works: Backlog still covers the `todo` category).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/board.ts packages/core/src/__tests__/board-settings.test.ts
git commit -m "feat(core): guard deleteBoardColumn against losing the last in_progress/done column"
```

---

## Task 4: Remove remaining `board.type` references

**Files:**
- Modify: `packages/core/src/project.ts:90`
- Modify: `apps/web/src/lib/mcp-server.ts:169`

**Interfaces:**
- Consumes: Task 1's schema change (the `type` column no longer exists, so the compiler will flag both of these; this task is verified by the compiler, not new tests).
- Produces: no more references to `board.type` anywhere in the codebase.

- [ ] **Step 1: Confirm the compiler catches both sites**

Run: `pnpm --filter @kompast/core exec tsc --noEmit && pnpm --filter @kompast/web exec tsc --noEmit`
Expected: FAIL — two errors, one at `packages/core/src/project.ts:90` (`type` doesn't exist on the board insert's expected shape) and one at `apps/web/src/lib/mcp-server.ts:169` (`schema.board.type` doesn't exist).

- [ ] **Step 2: Fix `packages/core/src/project.ts`**

In `createProject`, remove the `type: "kanban",` line from the board insert:

```ts
  const boardId = id("board");
  await tx.insert(schema.board).values({
    id: boardId,
    projectId,
    name: "Board utama",
  });
```

- [ ] **Step 3: Fix `apps/web/src/lib/mcp-server.ts`**

In the `list_boards` tool handler, drop `type` from the selected columns:

```ts
          return tx.select({ id: schema.board.id, name: schema.board.name }).from(schema.board).where(eq(schema.board.projectId, project.id));
```

- [ ] **Step 4: Run the type checks again to confirm both pass**

Run: `pnpm --filter @kompast/core exec tsc --noEmit && pnpm --filter @kompast/web exec tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/project.ts apps/web/src/lib/mcp-server.ts
git commit -m "chore: remove remaining board.type references after schema drop"
```

---

## Task 5: Server functions — sprint-aware board data, numbering, rename

**Files:**
- Modify: `apps/web/src/lib/server-fns/sprints.ts`
- Modify: `apps/web/src/lib/server-fns/projects.ts`

**Interfaces:**
- Consumes: `createSprint`/`updateSprint` (Task 2), `listSprints`/`listSprintIssues` (pre-existing, `packages/core/src/sprint.ts`).
- Produces: `createSprintFn` now accepts optional `name`/`number`/`startAt`/`endAt`; new `updateSprintFn`; `getProjectBoardFn`'s return type gains `hasAnySprint: boolean`, `activeSprint: Sprint | null`, `activeSprintIssueIds: string[]` — Task 6/7/8's UI components consume these three fields by name.

- [ ] **Step 1: Extend `apps/web/src/lib/server-fns/sprints.ts`**

Change the import from `@kompast/core` to add `updateSprint`:

```ts
import {
  createSprint,
  listSprints,
  getSprint,
  getSprintReport,
  listBacklogIssues,
  listSprintIssues,
  addIssueToSprint,
  removeIssueFromSprint,
  startSprint,
  completeSprint,
  updateSprint,
  withAuthorizedTenant,
} from "@kompast/core";
```

Replace `createSprintSchema`/`createSprintFn` with:

```ts
const createSprintSchema = z.object({
  boardId: z.string(),
  name: z.string().min(1).optional(),
  number: z.number().int().min(1).optional(),
  cycle: z.enum(["1w", "2w", "3w", "4w", "custom"]).optional(),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
});

export const createSprintFn = createServerFn({ method: "POST" })
  .validator(createSprintSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) =>
      createSprint(tx, {
        organizationId: ctx.organizationId,
        boardId: data.boardId,
        name: data.name,
        number: data.number,
        cycle: data.cycle,
        startAt: data.startAt,
        endAt: data.endAt,
      }),
    );
  });
```

Add this new export at the end of the file:

```ts
const updateSprintSchema = z.object({ sprintId: z.string(), name: z.string().min(1) });

export const updateSprintFn = createServerFn({ method: "POST" })
  .validator(updateSprintSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => updateSprint(tx, { sprintId: data.sprintId, name: data.name }));
    return { ok: true } as const;
  });
```

- [ ] **Step 2: Extend `apps/web/src/lib/server-fns/projects.ts`**

Change the `@kompast/core` import to add `listSprints`/`listSprintIssues`:

```ts
import {
  createProject,
  ForbiddenError,
  getBoard,
  getOrCreateDefaultTableView,
  listIssuePropertyDefinitions,
  listSprints,
  listSprintIssues,
  requireProjectAdmin,
  requireTeamAdmin,
  updateSavedViewConfig,
  withAuthorizedTenant,
} from "@kompast/core";
```

In `getProjectBoardFn`'s handler, add sprint data alongside the existing `Promise.all` and thread it into the return value:

```ts
      const [issueTypes, boardData, tableView, propertyDefinitions, sprints] = await Promise.all([
        tx.select().from(schema.issueType).where(eq(schema.issueType.projectId, project.id)),
        getBoard(tx, board.id),
        getOrCreateDefaultTableView(tx, board.id, ctx.userId),
        listIssuePropertyDefinitions(tx, project.id),
        listSprints(tx, board.id),
      ]);

      const activeSprint = sprints.find((s) => s.state === "active") ?? null;
      const activeSprintIssueIds = activeSprint ? (await listSprintIssues(tx, activeSprint.id)).map((i) => i.id) : [];

      const assigneeIds = [
        ...new Set(
          boardData.columns.flatMap((c) => c.issues.map((i) => i.assigneeId).filter((id): id is string => !!id)),
        ),
      ];
      const users =
        assigneeIds.length > 0
          ? await tx
              .select({ id: schema.user.id, name: schema.user.name })
              .from(schema.user)
              .where(inArray(schema.user.id, assigneeIds))
          : [];

      return {
        project,
        board,
        issueTypes,
        users,
        tableView,
        canManageProject,
        propertyDefinitions,
        hasAnySprint: sprints.length > 0,
        activeSprint,
        activeSprintIssueIds,
        ...boardData,
      };
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @kompast/web exec tsc --noEmit`
Expected: PASS.

**Note on test coverage:** this task has no dedicated automated test of its own. `apps/web`'s existing test suite only exercises REST/MCP file-route handlers directly (see `apps/web/src/routes/api/v1/__tests__/*`) — there's no established pattern in this repo for unit-testing a TanStack `createServerFn` wrapper in isolation, and these three functions are thin delegations to `createSprint`/`updateSprint`/`listSprints`/`listSprintIssues`, which Task 2 already covers against real Postgres. The two lines of genuinely new logic here (deriving `hasAnySprint`/`activeSprint`/`activeSprintIssueIds`) are covered by Task 10's manual walkthrough instead, consistent with how this repo verifies `apps/web` changes generally (root `CLAUDE.md`: a real container run, not deeper UI/loader unit tests, is the established bar for this app).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/server-fns/sprints.ts apps/web/src/lib/server-fns/projects.ts
git commit -m "feat(web): surface sprint data through the board loader, add rename/numbering to sprint server fns"
```

---

## Task 6: Translations — new keys for the wizard, Backlog tab, and Board empty state

**Files:**
- Modify: `packages/i18n/src/locales/en/board.json`
- Modify: `packages/i18n/src/locales/id/board.json`
- Modify: `packages/i18n/src/locales/zh-Hant/board.json`

**Interfaces:**
- Consumes: nothing.
- Produces: translation keys `tabs.backlog` and a set of new `sprint.*` keys that Task 7 (wizard), Task 8 (Backlog tab), and Task 9 (Board tab empty state) call via `t(...)`.

- [ ] **Step 1: Add the new keys to `packages/i18n/src/locales/en/board.json`**

In the `tabs` object, add (and remove the now-unused `"sprint": "Sprint"` entry — the Backlog tab replaces the Sprint tab):

```json
    "backlog": "Backlog",
```

In the `sprint` object, add these new keys (keep every existing key — they're reused verbatim by the new Backlog tab):

```json
    "wizardHeading": "Set up your first sprint",
    "wizardSubtitle": "Every board needs at least one sprint before it can be used.",
    "wizardCycleLabel": "Sprint duration",
    "wizardCycleCustom": "Custom",
    "cycle1w": "1 week",
    "cycle2w": "2 weeks",
    "cycle3w": "3 weeks",
    "cycle4w": "4 weeks",
    "wizardCustomStartLabel": "Start date",
    "wizardCustomEndLabel": "End date",
    "wizardCustomDatesRequired": "Enter both a start and end date for a custom sprint.",
    "wizardStartingNumberLabel": "Starting sprint number",
    "wizardStartingNumberHint": "Continuing from JIRA? Enter the next sprint number here.",
    "wizardInvalidNumber": "Enter a starting number of 1 or higher.",
    "wizardSubmitButton": "Create sprint",
    "activeSectionHeading": "Active sprint",
    "futureSectionHeading": "Upcoming sprints",
    "createSprintButton": "+ Create sprint",
    "noFutureSprints": "No upcoming sprints yet.",
    "renameHint": "Click to rename",
    "boardEmptyHeading": "No active sprint",
    "boardEmptySubtext": "Start a sprint from the Backlog tab to see work here."
```

- [ ] **Step 2: Add the equivalent keys to `packages/i18n/src/locales/id/board.json`**

In `tabs`:

```json
    "backlog": "Backlog",
```

In `sprint`:

```json
    "wizardHeading": "Siapkan sprint pertama",
    "wizardSubtitle": "Setiap board memerlukan minimal satu sprint sebelum dapat digunakan.",
    "wizardCycleLabel": "Durasi sprint",
    "wizardCycleCustom": "Kustom",
    "cycle1w": "1 minggu",
    "cycle2w": "2 minggu",
    "cycle3w": "3 minggu",
    "cycle4w": "4 minggu",
    "wizardCustomStartLabel": "Tanggal mulai",
    "wizardCustomEndLabel": "Tanggal selesai",
    "wizardCustomDatesRequired": "Masukkan tanggal mulai dan selesai untuk sprint kustom.",
    "wizardStartingNumberLabel": "Nomor sprint awal",
    "wizardStartingNumberHint": "Melanjutkan dari JIRA? Masukkan nomor sprint selanjutnya di sini.",
    "wizardInvalidNumber": "Masukkan nomor awal 1 atau lebih besar.",
    "wizardSubmitButton": "Buat sprint",
    "activeSectionHeading": "Sprint aktif",
    "futureSectionHeading": "Sprint mendatang",
    "createSprintButton": "+ Buat sprint",
    "noFutureSprints": "Belum ada sprint mendatang.",
    "renameHint": "Klik untuk mengubah nama",
    "boardEmptyHeading": "Tidak ada sprint aktif",
    "boardEmptySubtext": "Mulai sprint dari tab Backlog untuk melihat pekerjaan di sini."
```

- [ ] **Step 3: Add the equivalent keys to `packages/i18n/src/locales/zh-Hant/board.json`**

In `tabs`:

```json
    "backlog": "待辦清單",
```

In `sprint`:

```json
    "wizardHeading": "設定你的第一個衝刺",
    "wizardSubtitle": "每個看板在使用前都需要至少一個衝刺。",
    "wizardCycleLabel": "衝刺長度",
    "wizardCycleCustom": "自訂",
    "cycle1w": "1 週",
    "cycle2w": "2 週",
    "cycle3w": "3 週",
    "cycle4w": "4 週",
    "wizardCustomStartLabel": "開始日期",
    "wizardCustomEndLabel": "結束日期",
    "wizardCustomDatesRequired": "請輸入自訂衝刺的開始與結束日期。",
    "wizardStartingNumberLabel": "起始衝刺編號",
    "wizardStartingNumberHint": "從 JIRA 延續？在此輸入下一個衝刺編號。",
    "wizardInvalidNumber": "請輸入 1 或以上的起始編號。",
    "wizardSubmitButton": "建立衝刺",
    "activeSectionHeading": "進行中的衝刺",
    "futureSectionHeading": "即將到來的衝刺",
    "createSprintButton": "+ 建立衝刺",
    "noFutureSprints": "尚無即將到來的衝刺。",
    "renameHint": "點擊以重新命名",
    "boardEmptyHeading": "沒有進行中的衝刺",
    "boardEmptySubtext": "從待辦清單頁籤開始一個衝刺，即可在此查看工作項目。"
```

Also remove the now-unused `"sprint": "衝刺"` line from `tabs` in this file (same removal as Step 1's `en` file and Step 2's `id` file).

- [ ] **Step 4: Verify all three JSON files still parse**

Run: `node -e "['en','id','zh-Hant'].forEach(l => JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/'+l+'/board.json','utf-8')))" && echo OK`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add packages/i18n/src/locales/en/board.json packages/i18n/src/locales/id/board.json packages/i18n/src/locales/zh-Hant/board.json
git commit -m "i18n: add translation keys for sprint setup wizard and Backlog tab"
```

---

## Task 7: `SprintSetupWizard` component + route gating

**Files:**
- Modify: `apps/web/src/routes/_app/projects/$projectKey.tsx`

**Interfaces:**
- Consumes: `data.hasAnySprint` (Task 5), `createSprintFn` (Task 5), translation keys from Task 6.
- Produces: `SprintSetupWizard({ boardId, onCreated })` component, used by Task 8 (Board tab) and Task 9 (Backlog tab) whenever `!data.hasAnySprint`.

- [ ] **Step 1: Add the `SprintSetupWizard` component**

Add this new function to `apps/web/src/routes/_app/projects/$projectKey.tsx`, right before the `function BoardView(...)` definition:

```tsx
const CYCLE_OPTIONS: Array<{ value: "1w" | "2w" | "3w" | "4w" | "custom"; labelKey: string }> = [
  { value: "1w", labelKey: "sprint.cycle1w" },
  { value: "2w", labelKey: "sprint.cycle2w" },
  { value: "3w", labelKey: "sprint.cycle3w" },
  { value: "4w", labelKey: "sprint.cycle4w" },
  { value: "custom", labelKey: "sprint.wizardCycleCustom" },
];

function SprintSetupWizard({ boardId, onCreated }: { boardId: string; onCreated: () => void }) {
  const { t } = useTranslation("board");
  const [cycle, setCycle] = useState<"1w" | "2w" | "3w" | "4w" | "custom">("2w");
  const [startingNumber, setStartingNumber] = useState("1");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const number = Number.parseInt(startingNumber, 10);
    if (!Number.isInteger(number) || number < 1) {
      setError(t("sprint.wizardInvalidNumber"));
      return;
    }
    if (cycle === "custom" && (!customStart || !customEnd)) {
      setError(t("sprint.wizardCustomDatesRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createSprintFn({
        data: {
          boardId,
          number,
          cycle,
          startAt: cycle === "custom" ? new Date(customStart) : undefined,
          endAt: cycle === "custom" ? new Date(customEnd) : undefined,
        },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6">
      <div className="mx-auto max-w-[480px] rounded-xl border border-border bg-surface p-6">
        <p className="mb-1 type-title">{t("sprint.wizardHeading")}</p>
        <p className="mb-5 type-body text-text-2">{t("sprint.wizardSubtitle")}</p>

        <label className="mb-4 block">
          <span className="mb-1 block text-[12px] text-text-2">{t("sprint.wizardCycleLabel")}</span>
          <select
            value={cycle}
            onChange={(e) => setCycle(e.target.value as typeof cycle)}
            className="kp-select w-full rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none"
          >
            {CYCLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </option>
            ))}
          </select>
        </label>

        {cycle === "custom" && (
          <div className="mb-4 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[12px] text-text-2">{t("sprint.wizardCustomStartLabel")}</span>
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="w-full rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] text-text-2">{t("sprint.wizardCustomEndLabel")}</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="w-full rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none"
              />
            </label>
          </div>
        )}

        <label className="mb-5 block">
          <span className="mb-1 block text-[12px] text-text-2">{t("sprint.wizardStartingNumberLabel")}</span>
          <input
            type="number"
            min={1}
            value={startingNumber}
            onChange={(e) => setStartingNumber(e.target.value)}
            className="w-full rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none"
          />
          <span className="mt-1 block text-[11.5px] text-text-3">{t("sprint.wizardStartingNumberHint")}</span>
        </label>

        {error && <p className="mb-4 rounded-[7px] border border-danger-soft bg-danger-soft px-3 py-2 type-body text-danger">{error}</p>}

        <Button variant="primary" onClick={submit} disabled={busy}>
          {t("sprint.wizardSubmitButton")}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @kompast/web exec tsc --noEmit`
Expected: PASS (the component isn't wired into the route yet, but it must compile standalone).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/_app/projects/\$projectKey.tsx
git commit -m "feat(web): add SprintSetupWizard component"
```

---

## Task 8: Backlog tab (replaces the Sprint tab)

**Files:**
- Modify: `apps/web/src/routes/_app/projects/$projectKey.tsx`

**Interfaces:**
- Consumes: `listSprintsFn`, `listBacklogFn`, `getSprintDetailFn`, `createSprintFn`, `updateSprintFn`, `startSprintFn`, `completeSprintFn`, `addIssueToSprintFn`, `removeIssueFromSprintFn` (all pre-existing or from Task 5), `SprintSetupWizard` (Task 7), translation keys (Task 6).
- Produces: `BacklogTab({ projectId, boardId })` component; the `"backlog"` view key in `VIEW_TABS`; removes the `"sprint"` view key and the old `SprintTab` function (its AI-summary feature moves into this component's active-sprint section; `SprintReviewTable` stays defined, unreferenced until sub-project 5 wires it into the Table tab).

**Deviation from spec:** the design spec describes moving issues between the Backlog/Active/Future sections via drag-and-drop, "going through the existing `addIssueToSprint`/`removeIssueFromSprint`." This task implements that same underlying movement (same two core functions, same functional outcome) through a `<select>` dropdown per backlog issue plus a "Remove" button per sprint issue, instead of real drag-and-drop. Reason: `BoardView`'s drag-and-drop (dnd-kit sensors, keyboard-nav fallback, focus preservation across re-renders) is a substantial, purpose-built pattern — replicating it across three section types (backlog↔active, backlog↔future-N, future-M↔future-N) would roughly double this task's size for a UI interaction, not a new capability. The dropdown/button achieves the identical end state and is simpler to keyboard-navigate. Flag this to the user before/after implementation in case real drag-and-drop is wanted instead — it would be a self-contained follow-up task against the same `addIssueToSprint`/`removeIssueFromSprint` functions, not a data-model change.

- [ ] **Step 1: Replace the `SprintTab` function**

In `apps/web/src/routes/_app/projects/$projectKey.tsx`, delete the entire existing `function SprintTab(...)` (from its `function SprintTab({ projectId, boardId, boardData }...` line through its closing `}` — the block right before the `SprintReviewTable` comment) and replace it with:

```tsx
function BacklogTab({ projectId, boardId }: { projectId: string; boardId: string }) {
  const { t } = useTranslation("board");
  const [sprints, setSprints] = useState<SprintSummary[] | null>(null);
  const [backlog, setBacklog] = useState<BacklogIssue[] | null>(null);
  const [details, setDetails] = useState<Record<string, SprintDetail>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  async function refresh() {
    const [list, backlogList] = await Promise.all([listSprintsFn({ data: boardId }), listBacklogFn({ data: projectId })]);
    setSprints(list);
    setBacklog(backlogList);
    const relevant = list.filter((s) => s.state !== "closed");
    const detailEntries = await Promise.all(relevant.map((s) => getSprintDetailFn({ data: s.id }).then((d) => [s.id, d] as const)));
    setDetails(Object.fromEntries(detailEntries));
  }

  useEffect(() => {
    refresh();
    setAiSummary(null);
    setAiError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, boardId]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setBusy(false);
    }
  }

  const createFutureSprint = () => withBusy(async () => { await createSprintFn({ data: { boardId } }); });
  const handleStart = (sprintId: string) => withBusy(async () => { await startSprintFn({ data: sprintId }); });
  const handleComplete = (sprintId: string) => withBusy(async () => { await completeSprintFn({ data: { sprintId } }); });
  const addToSprint = (sprintId: string, issueId: string) => withBusy(async () => { await addIssueToSprintFn({ data: { sprintId, issueId } }); });
  const removeFromSprint = (issueId: string) => withBusy(async () => { await removeIssueFromSprintFn({ data: issueId }); });

  async function saveRename(sprintId: string) {
    const trimmed = renameValue.trim();
    setRenamingId(null);
    if (!trimmed) return;
    await withBusy(async () => { await updateSprintFn({ data: { sprintId, name: trimmed } }); });
  }

  async function generateAiSummary(sprintId: string) {
    setAiBusy(true);
    setAiError(null);
    setAiSummary("");
    try {
      await streamAiCompletion({ feature: "sprint-summary", sprintId }, (delta) => {
        setAiSummary((prev) => (prev ?? "") + delta);
      });
    } catch (err) {
      setAiError(err instanceof Error ? err.message : t("sprint.aiSummaryFailed"));
    } finally {
      setAiBusy(false);
    }
  }

  if (sprints === null || backlog === null) {
    return <p className="p-6 type-body text-text-3">{t("loadingEllipsis")}</p>;
  }

  const activeSprint = sprints.find((s) => s.state === "active") ?? null;
  const futureSprints = sprints.filter((s) => s.state === "future").sort((a, b) => a.number - b.number);

  function SprintHeading({ sprint }: { sprint: SprintSummary }) {
    if (renamingId === sprint.id) {
      return (
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={() => saveRename(sprint.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveRename(sprint.id);
            if (e.key === "Escape") setRenamingId(null);
          }}
          className="rounded-[7px] border border-border-2 bg-surface px-2 py-1 text-[13px] outline-none"
        />
      );
    }
    return (
      <button
        type="button"
        onClick={() => { setRenamingId(sprint.id); setRenameValue(sprint.name); }}
        className="type-label-overline text-text-3 hover:text-text-2"
        title={t("sprint.renameHint")}
      >
        {sprint.name}
      </button>
    );
  }

  function SprintSection({ sprint }: { sprint: SprintSummary }) {
    const detail = details[sprint.id];
    return (
      <div className="rounded-xl border border-border bg-surface p-3">
        <div className="mb-2 flex items-center justify-between">
          <SprintHeading sprint={sprint} />
          {sprint.state === "future" && (
            <Button variant="outline" disabled={busy} onClick={() => handleStart(sprint.id)}>
              {t("sprint.start")}
            </Button>
          )}
          {sprint.state === "active" && (
            <Button variant="outline" disabled={busy} onClick={() => handleComplete(sprint.id)}>
              {t("sprint.complete")}
            </Button>
          )}
        </div>
        {detail && (
          <p className="mb-2 type-body text-text-2">
            {t("sprint.scopeLabel")} <strong>{detail.report.scopeIssueCount}</strong> {t("sprint.issuesUnit")} / <strong>{detail.report.scopePoints}</strong> {t("sprint.pointsUnit")}
            {" · "}
            {t("sprint.completedLabel")} <strong>{detail.report.completedIssueCount}</strong> {t("sprint.issuesUnit")} / <strong>{detail.report.completedPoints}</strong> {t("sprint.pointsUnit")}
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          {(!detail || detail.issues.length === 0) && <p className="type-body text-text-3">{t("sprint.noIssuesInSprint")}</p>}
          {detail?.issues.map((issue) => (
            <div key={issue.id} className="flex items-center justify-between rounded-[9px] border border-border px-2 py-1.5">
              <span className="truncate type-body">{issue.title}</span>
              <Button variant="outline" disabled={busy} onClick={() => removeFromSprint(issue.id)}>
                {t("sprint.removeButton")}
              </Button>
            </div>
          ))}
        </div>
        {sprint.state === "active" && (
          <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
            <div className="flex items-center justify-between">
              <p className="type-label-overline text-text-3">{t("sprint.aiSummaryHeading")}</p>
              <Button variant="outline" onClick={() => generateAiSummary(sprint.id)} disabled={aiBusy}>
                {aiBusy ? t("sprint.writingEllipsis") : t("sprint.generateSummary")}
              </Button>
            </div>
            {aiError && <p className="type-body text-danger">{aiError}</p>}
            {aiSummary !== null && !aiError && <p className="whitespace-pre-wrap type-body text-text-2">{aiSummary || "…"}</p>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      {error && <p className="rounded-[7px] border border-danger-soft bg-danger-soft px-3 py-2 type-body text-danger">{error}</p>}

      {activeSprint && (
        <div>
          <p className="mb-2 type-label-overline text-text-3">{t("sprint.activeSectionHeading")}</p>
          <SprintSection sprint={activeSprint} />
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="type-label-overline text-text-3">{t("sprint.futureSectionHeading")}</p>
          <Button variant="outline" disabled={busy} onClick={createFutureSprint}>
            {t("sprint.createSprintButton")}
          </Button>
        </div>
        <div className="flex flex-col gap-3">
          {futureSprints.length === 0 && <p className="type-body text-text-3">{t("sprint.noFutureSprints")}</p>}
          {futureSprints.map((s) => (
            <SprintSection key={s.id} sprint={s} />
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface p-3">
        <p className="mb-2 type-label-overline text-text-3">{t("sprint.backlogHeading")}</p>
        <div className="flex flex-col gap-1.5">
          {backlog.length === 0 && <p className="type-body text-text-3">{t("sprint.backlogEmpty")}</p>}
          {backlog.map((issue) => (
            <div key={issue.id} className="flex items-center justify-between rounded-[9px] border border-border px-2 py-1.5">
              <span className="truncate type-body">{issue.title}</span>
              <select
                disabled={busy || (!activeSprint && futureSprints.length === 0)}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) addToSprint(e.target.value, issue.id);
                  e.target.value = "";
                }}
                className="kp-select rounded-[7px] border border-border-2 bg-surface px-2 py-1 text-[12px] outline-none"
              >
                <option value="" disabled>
                  {t("sprint.addToSprintButton")}
                </option>
                {activeSprint && <option value={activeSprint.id}>{activeSprint.name}</option>}
                {futureSprints.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

Add `updateSprintFn` to the existing `@/lib/server-fns/sprints` import at the top of the file:

```ts
import {
  listSprintsFn,
  listBacklogFn,
  getSprintDetailFn,
  createSprintFn,
  updateSprintFn,
  startSprintFn,
  completeSprintFn,
  addIssueToSprintFn,
  removeIssueFromSprintFn,
} from "@/lib/server-fns/sprints";
```

- [ ] **Step 2: Wire the new tab into `ProjectPage`**

Replace the `"sprint"` entry in `VIEW_TABS` (currently `{ key: "sprint", label: t("tabs.sprint"), icon: <Flag {...iconProps} /> }`) with a `"backlog"` entry placed first, before `"board"`:

```tsx
  const VIEW_TABS = [
    { key: "backlog", label: t("tabs.backlog"), icon: <Inbox {...iconProps} /> },
    { key: "board", label: t("tabs.board"), icon: <Kanban {...iconProps} /> },
    { key: "table", label: t("tabs.table"), icon: <Table2 {...iconProps} /> },
    { key: "roadmap", label: t("tabs.roadmap"), icon: <MapIcon {...iconProps} /> },
    { key: "docs", label: t("tabs.docs"), icon: <FileText {...iconProps} /> },
    { key: "automation", label: t("tabs.automation"), icon: <Zap {...iconProps} /> },
    { key: "import", label: t("tabs.import"), icon: <Download {...iconProps} /> },
  ];
```

Add `Inbox` to the `lucide-react` import at the top of the file:

```tsx
import { Kanban, Flag, Table2, Map as MapIcon, FileText, Zap, Download, Settings, Search, Inbox } from "lucide-react";
```

(`Flag` is no longer used by any tab now that `"sprint"` is gone, but it may still be used elsewhere in this large file — leave the import as-is; the compiler will flag it in Step 3 below if it's genuinely unused, and only then should it be removed.)

Also default the initial view to `"backlog"` instead of `"board"`, since a brand-new board's first stop should be sprint setup, not an empty board:

```tsx
  const [view, setView] = useState("backlog");
```

Replace the `{view === "sprint" && <SprintTab .../>}` line with:

```tsx
      {view === "backlog" && <BacklogTab projectId={data.project.id} boardId={data.board.id} />}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @kompast/web exec tsc --noEmit`
Expected: PASS. If `Flag` is reported unused, remove it from the `lucide-react` import line.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/_app/projects/\$projectKey.tsx
git commit -m "feat(web): replace Sprint tab with Jira-style Backlog tab"
```

---

## Task 9: Sprint-scoped Board tab + setup-wizard gating

**Files:**
- Modify: `apps/web/src/routes/_app/projects/$projectKey.tsx`

**Interfaces:**
- Consumes: `data.hasAnySprint`, `data.activeSprint`, `data.activeSprintIssueIds` (Task 5), `SprintSetupWizard` (Task 7), `EmptyStatePanel` (pre-existing, this file).
- Produces: `BoardView` only renders columns/issues for the board's active sprint; both the Board and Backlog tabs show the setup wizard until the board has at least one sprint.

- [ ] **Step 1: Narrow `BoardView`'s columns to the active sprint, excluding Backlog**

In `function BoardView({ data }: { data: BoardData })`, replace the existing `columns` derivation:

```tsx
  const needle = search.trim().toLowerCase();
  const columns = needle
    ? data.columns.map((col) => ({
        ...col,
        issues: col.issues.filter(
          (i) => i.title.toLowerCase().includes(needle) || `${data.project.key}-${i.keySeq}`.toLowerCase().includes(needle),
        ),
      }))
    : data.columns;
```

with:

```tsx
  const activeSprintIssueIds = new Set(data.activeSprintIssueIds);
  const needle = search.trim().toLowerCase();
  const columns = data.columns
    .filter((col) => !col.isBacklog)
    .map((col) => ({ ...col, issues: col.issues.filter((i) => activeSprintIssueIds.has(i.id)) }))
    .map((col) =>
      needle
        ? { ...col, issues: col.issues.filter((i) => i.title.toLowerCase().includes(needle) || `${data.project.key}-${i.keySeq}`.toLowerCase().includes(needle)) }
        : col,
    );
```

- [ ] **Step 2: Add the "no active sprint" empty state**

`BoardView` calls hooks (`useState`, `useSensors`, `useRef`, `useEffect`) all the way down to its `moveToAdjacentColumn` function, and only then reaches its JSX `return (`. The empty-state check must go **after every hook call** — inserting it right after the `columns` derivation would conditionally skip the later `useEffect`/`useRef` calls on some renders, violating React's Rules of Hooks. Add it immediately before the component's final `return (`, i.e. right before the existing:

```tsx
  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
```

insert:

```tsx
  if (!data.activeSprint) {
    return (
      <div className="p-6">
        <EmptyStatePanel overline={t("tabs.board")} heading={t("sprint.boardEmptyHeading")} subtext={t("sprint.boardEmptySubtext")} />
      </div>
    );
  }

```

- [ ] **Step 3: Gate the Board and Backlog tabs on `hasAnySprint`**

In `ProjectPage`'s render, replace:

```tsx
      {view === "board" && <BoardView data={data} />}
```

```tsx
      {view === "backlog" && <BacklogTab projectId={data.project.id} boardId={data.board.id} />}
```

with:

```tsx
      {view === "board" && (
        data.hasAnySprint
          ? <BoardView data={data} />
          : <SprintSetupWizard boardId={data.board.id} onCreated={() => { router.invalidate(); setView("backlog"); }} />
      )}
      {view === "backlog" && (
        data.hasAnySprint
          ? <BacklogTab projectId={data.project.id} boardId={data.board.id} />
          : <SprintSetupWizard boardId={data.board.id} onCreated={() => router.invalidate()} />
      )}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @kompast/web exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/_app/projects/\$projectKey.tsx
git commit -m "feat(web): scope Board tab to the active sprint, gate both tabs on sprint setup"
```

---

## Task 10: Full verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: nothing — this task's output is confidence, not code.

- [ ] **Step 1: Whole-workspace typecheck, build, and test**

Run: `pnpm typecheck && pnpm build && pnpm test`
Expected: all green across all packages, including the new/modified tests from Tasks 2 and 3.

- [ ] **Step 2: Real Docker build/run of `kompast-web`**

Per root `CLAUDE.md` ("Verifying a change to a deployable service"), `pnpm build`/`vitest` never touch the actual bundled output — a real container build is required for any `apps/web` change:

```bash
docker build -f infra/Dockerfile.web -t kompast-web-sprint-foundation .
docker run --rm -e DATABASE_URL -e DATABASE_ADMIN_URL -e REDIS_URL -e BETTER_AUTH_SECRET -p 3000:3000 kompast-web-sprint-foundation
```

Expected: the container builds and starts without error (no `__dirname`-relative path failures, no ESM/CJS loader errors).

- [ ] **Step 3: Manual walkthrough**

Against the running container (or `pnpm dev`), with a fresh project (no sprints yet):
1. Open the project page — it should default to the Backlog tab, showing the setup wizard.
2. Submit the wizard with a starting number (e.g. `42`) and a `2w` cycle — expect to land on the Backlog tab showing "Sprint 42" under "Upcoming sprints", with the project's existing issues (if any) all listed under "Backlog".
3. Click "Sprint 42"'s name — confirm it becomes an editable input; rename it and confirm the new name persists after a refresh.
4. Add an issue from the Backlog section into "Sprint 42" — confirm it moves out of Backlog and into the sprint's issue list.
5. Click "Start sprint" — confirm it moves to "Active sprint" at the top.
6. Switch to the Board tab — confirm it now shows only non-Backlog columns, populated only with the active sprint's issues.
7. Click "+ Create sprint" on the Backlog tab — confirm the new one is numbered `43` with no prompt for a name.
8. Try deleting the "Done" column from board settings (if a settings UI exists for this) or call `deleteBoardColumn` directly — confirm it's refused once it's the last `done`-category column.

Record any deviation from the above as a blocker and stop — per the executing-plans skill, do not guess past a failed verification.

- [ ] **Step 4: Report completion**

Summarize what was verified (Steps 1–3) to the user. Do not push the branch or merge to `main` — per this plan's Global Constraints, that requires the user's explicit go-ahead.
