import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
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
  withAuthorizedTenant,
} from "@kompast/core";
import { requireAuthContext } from "../session";

export const listSprintsFn = createServerFn({ method: "GET" })
  .validator((boardId: string) => boardId)
  .handler(async ({ data: boardId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => listSprints(tx, boardId));
  });

export const listBacklogFn = createServerFn({ method: "GET" })
  .validator((projectId: string) => projectId)
  .handler(async ({ data: projectId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => listBacklogIssues(tx, projectId));
  });

export const getSprintDetailFn = createServerFn({ method: "GET" })
  .validator((sprintId: string) => sprintId)
  .handler(async ({ data: sprintId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      const [sprint, report, issues] = await Promise.all([getSprint(tx, sprintId), getSprintReport(tx, sprintId), listSprintIssues(tx, sprintId)]);
      return { sprint, report, issues };
    });
  });

const createSprintSchema = z.object({
  boardId: z.string(),
  name: z.string().min(1),
  cycle: z.enum(["1w", "2w", "3w", "4w", "custom"]).optional(),
});

export const createSprintFn = createServerFn({ method: "POST" })
  .validator(createSprintSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) =>
      createSprint(tx, { organizationId: ctx.organizationId, boardId: data.boardId, name: data.name, cycle: data.cycle }),
    );
  });

export const startSprintFn = createServerFn({ method: "POST" })
  .validator((sprintId: string) => sprintId)
  .handler(async ({ data: sprintId }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => startSprint(tx, { sprintId, actorId: ctx.userId }));
    return { ok: true } as const;
  });

const completeSprintSchema = z.object({ sprintId: z.string(), carryToSprintId: z.string().optional() });

export const completeSprintFn = createServerFn({ method: "POST" })
  .validator(completeSprintSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => completeSprint(tx, { sprintId: data.sprintId, actorId: ctx.userId, carryToSprintId: data.carryToSprintId }));
  });

const sprintIssueSchema = z.object({ sprintId: z.string(), issueId: z.string() });

export const addIssueToSprintFn = createServerFn({ method: "POST" })
  .validator(sprintIssueSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, data.sprintId, data.issueId));
    return { ok: true } as const;
  });

export const removeIssueFromSprintFn = createServerFn({ method: "POST" })
  .validator((issueId: string) => issueId)
  .handler(async ({ data: issueId }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => removeIssueFromSprint(tx, issueId));
    return { ok: true } as const;
  });
