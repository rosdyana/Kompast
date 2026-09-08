# Board/Sprint Foundation — Design Spec

**Status:** Approved for planning
**Date:** 2026-09-08
**Scope:** Sub-project 1 of the kanban system rework (see "Program context" below)

## Program context

This is the first of several largely-independent sub-projects that together make up a broader kanban rework the user requested:

1. **Board/sprint foundation** (this spec) — mandatory sprint per board, a Jira-style Backlog tab distinct from the Backlog column, sprint numbering, required-columns guard.
2. Card detail redesign — tabbed activity/comments, standardized attribute set, in-place status change.
3. Automation rewritten as an n8n-style node-based workflow engine (biggest single piece, most architecturally distinct from today's flat trigger→conditions→actions engine).
4. Parent category → sub-project grouping surfaced in the roadmap/timeline tab.
5. Sprint-scoped meeting-minutes space (review/retro/planning) alongside the existing sprint-review table.

Each gets its own spec → plan → implementation cycle. This document covers **only** sub-project 1.

## Current state (verified against the codebase, not the README summary)

- **Columns/statuses are already two separate, per-project-configurable concepts**: `workflowStatus` (project-scoped, `category` enum `todo`/`in_progress`/`done`) and `boardColumn`/`boardColumnStatus` (many-to-many join, so renaming/reordering a column never touches an issue row). `boardColumn.isBacklog` marks the one non-deletable column new issues land in by default. Backlog is not a separate concept from a column today — it's just a `workflowStatus` with `category: "todo"`.
- **Only one board per project exists in practice** — no `createBoard` function, REST/MCP endpoint, or UI exists; `createProject` is the only code path that inserts a board row, and it inserts exactly one. This spec does not need to handle multi-board-per-project UX.
- **Only one active sprint per board is enforced** today (`startSprint` throws if another is already `state: "active"`), but **board creation never forces sprint setup** — a board can exist and be used indefinitely with zero sprints.
- **No sprint numbering concept exists** — a sprint's only identity is a free-text `name`. This spec introduces it from scratch.
- **All six of the requested default card attributes already exist on the `issue` schema** (`sprintId`, `priority`, `assigneeId`, `startDate`, `dueDate`, `estimateSeconds`, `reporterId`) — this spec does not touch card attributes; that's sub-project 2's job.
- **`board.type` (`kanban`/`scrum`) currently gates nothing relevant** beyond board metadata — sprints are already usable regardless of type, just optional. This spec drops the field entirely since every board will now behave identically.

## 1. Data model changes

- **`sprint.number`** (new column, `integer not null`, unique per `boardId` via a composite unique index `(boardId, number)`): the auto-incrementing sprint number.
  - The setup wizard sets it explicitly for a board's first-ever sprint, from the wizard's "starting number" input (default `1`, overridable for JIRA continuation).
  - Every subsequent sprint on that board computes `number = (SELECT MAX(number) FROM sprint WHERE boardId = X) + 1` at creation time inside `createSprint`. No separate counter column — sprint creation is not a hot path, and the existing one-active-sprint-per-board constraint means there's no realistic concurrent-creation race to guard against beyond the unique index (which fails loud if one ever occurs).
  - Default sprint name becomes `"Sprint {number}"` at creation; the user can rename the sprint afterward (matches Jira) — the `number` field keeps incrementing independently of whatever the name becomes.
- **`board.type` is removed.** Migration drops the column; no code path branches on it after this change.
- **No new "setup complete" flag on `board`.** Whether a board needs the wizard is derived at read time: `EXISTS(SELECT 1 FROM sprint WHERE boardId = X)`. A persisted boolean would just be a cache of this query that could drift.

### Migration

One migration, two parts:

1. **Backfill `sprint.number`** for every board that already has sprint rows: order that board's sprints by `createdAt`, assign `1, 2, 3, …`. These boards never see the setup wizard — they already satisfy "at least one sprint exists."
2. **Drop `board.type`.**

Boards with zero sprint rows get nothing backfilled — they naturally hit the wizard the next time anyone opens their Board or Backlog tab. No batch job, no explicit migration flag required for this case.

## 2. Setup wizard

- **Trigger**: opening the Board tab or the Backlog tab for a board with zero sprints ever created (the same derived check as above) renders the wizard in place of the normal tab content.
- **Fields**: cycle duration (`1w`/`2w`/`3w`/`4w`/`custom` — reusing the existing `sprint.cycle` enum; `custom` additionally asks for explicit start/end dates), and starting sprint number (default `1`).
- **On submit**: calls the existing `createSprint` (extended to accept an explicit `number`) with `state: "future"`. The sprint is **not** auto-started — starting a sprint stays a deliberate, visible action taken from the Backlog tab, not something the setup form does silently. The user is routed to the Backlog tab after submit.

## 3. Backlog tab (new)

A new tab, distinct from the Backlog *column*. Three stacked sections, top to bottom:

1. **Active sprint** (rendered only if one exists): flat list of its issues, with a "Complete sprint" action that calls the existing `completeSprint` unchanged (already handles carrying not-done issues to another sprint or back to the backlog, and writes the completion snapshot).
2. **Future sprints** (one collapsible section per `state: "future"` sprint, ordered by `number` ascending): each has a "Start sprint" action (still enforced as one-active-per-board — surfaces today's existing error if another sprint is active) and a page-level "+ Create sprint" action that computes the next auto-number as described above.
3. **Backlog**: issues with `sprintId IS NULL`, reusing the existing `listBacklogIssues` query unchanged.

Drag-and-drop between all three sections goes through the existing `addIssueToSprint`/`removeIssueFromSprint` in `packages/core/src/sprint.ts` — no new core mutations are needed; this is a new UI surface over existing sprint-membership operations.

## 4. Board tab (now sprint-scoped)

- Renders only `boardColumn`s where `isBacklog = false` — the Backlog column no longer appears on the Board tab at all (it only surfaces in the Backlog tab's "Backlog" section).
- Only shows issues belonging to the board's currently **active** sprint (`sprintId = <active sprint id>`). Issues with no sprint, or belonging to a future/completed sprint, never appear here.
- If no sprint is currently active (all sprints are future-state, or none exist yet — though the latter triggers the wizard first), the Board tab shows an empty state directing the user to the Backlog tab to start one.

## 5. Required-columns guard

Today only the Backlog column is protected from deletion (`boardColumn.isBacklog`, checked in `deleteBoardColumn`, which repoints orphaned statuses to it). Nothing stops deleting every column mapped to the `in_progress` or `done` categories, which would violate "kanban should always have backlog, in progress, done."

Extend `deleteBoardColumn` (`packages/core/src/board.ts`) to refuse deleting the last remaining column mapped to any of the three required categories (`todo`/`in_progress`/`done`) — the same shape as the existing backlog protection (which is really just the `todo`-category case today), generalized to cover all three. Custom columns beyond these three remain freely addable/deletable, per the original request.

## Testing

Following repo convention (real Postgres integration tests, no mocking of the DB):

- `sprint.ts` tests: first sprint on a board takes the wizard-supplied `number`; second+ sprint auto-computes `max + 1`; uniqueness constraint holds per board (two boards can each have a `number = 1`).
- Migration test/verification: backfill assigns sequential numbers by `createdAt` for boards with pre-existing sprints; boards with none are left alone.
- `board.ts` tests: `deleteBoardColumn` now rejects deleting the last `in_progress`- or `done`-category column, same as it already does for backlog today.
- Route-level tests for the Board tab query (only active-sprint issues, non-backlog columns) and Backlog tab query (active + future sprints + `sprintId IS NULL` backlog), invoking the route handlers directly per repo convention.
- Manual/UI verification: wizard flow on a fresh project, drag-and-drop in the Backlog tab, Board tab emptying out correctly when no sprint is active.

## Out of scope (deferred to later sub-projects)

- Card attribute UI (sprint/priority/assignee/dates/estimate/reporter editability, tabbed activity/comments, in-place status change) — sub-project 2.
- Automation rework into a node-based workflow engine, and exposing all columns (including custom ones) as automation conditions/triggers — sub-project 3.
- Parent-category/sub-project grouping in the roadmap — sub-project 4.
- Sprint meeting-minutes (review/retro/planning) space — sub-project 5. The existing `SprintReviewTable` (table tab filtered to sprint scope) already satisfies "the table tab follows the sprint condition" and needs no changes here.
