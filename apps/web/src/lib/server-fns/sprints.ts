import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import {
  createSprint,
  listSprints,
  getSprint,
  getSprintReport,
  listBacklogIssues,
  listSprintIssues,
  getSprintMinutesPage,
  getOrCreateSprintRetroPage,
  reorderSprintIssue,
  addIssueToSprint,
  removeIssueFromSprint,
  startSprint,
  completeSprint,
  updateSprint,
  sendSprintSummaryEmail,
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
      const [sprint, report, issues, minutesPage, retroPage] = await Promise.all([
        getSprint(tx, sprintId),
        getSprintReport(tx, sprintId),
        listSprintIssues(tx, sprintId),
        getSprintMinutesPage(tx, sprintId),
        getOrCreateSprintRetroPage(tx, sprintId, ctx.userId),
      ]);
      return { sprint, report, issues, minutesPageId: minutesPage?.id ?? null, retroPageId: retroPage?.id ?? null };
    });
  });

const reorderSprintIssueSchema = z.object({
  sprintId: z.string(),
  issueId: z.string(),
  beforeIssueId: z.string().optional(),
  afterIssueId: z.string().optional(),
});

export const reorderSprintIssueFn = createServerFn({ method: "POST" })
  .validator(reorderSprintIssueSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => reorderSprintIssue(tx, data));
    return { ok: true } as const;
  });

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
        actorUserId: ctx.userId,
      }),
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

const updateSprintSchema = z.object({ sprintId: z.string(), name: z.string().min(1) });

export const updateSprintFn = createServerFn({ method: "POST" })
  .validator(updateSprintSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => updateSprint(tx, { sprintId: data.sprintId, name: data.name }));
    return { ok: true } as const;
  });

const sendSprintSummaryEmailSchema = z.object({
  sprintId: z.string(),
  recipients: z.array(z.email()).min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
});

export const sendSprintSummaryEmailFn = createServerFn({ method: "POST" })
  .validator(sendSprintSummaryEmailSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) =>
      sendSprintSummaryEmail(tx, {
        organizationId: ctx.organizationId,
        sprintId: data.sprintId,
        recipients: data.recipients,
        subject: data.subject,
        body: data.body,
      }),
    );
  });
