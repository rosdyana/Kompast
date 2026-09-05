import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { eq, schema } from "@kompast/db";
import {
  createWorkflowStatus,
  deleteBoardColumn,
  reorderBoardColumns,
  requireProjectAccess,
  requireProjectAdmin,
  updateBoardColumn,
  withAuthorizedTenant,
} from "@kompast/core";
import { requireAuthContext } from "../session";

/** The board's status sequence, for the "Kolom kanban" tab's flow banner — reads don't need admin, just project access. */
export const listWorkflowStatusesFn = createServerFn({ method: "GET" })
  .validator((projectId: string) => projectId)
  .handler(async ({ data: projectId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      await requireProjectAccess(tx, { ...ctx, projectId });
      return tx.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, projectId)).orderBy(schema.workflowStatus.order);
    });
  });

const createBoardColumnSchema = z.object({ projectId: z.string(), boardId: z.string(), name: z.string().min(1) });

/**
 * "+ Add column" reuses createWorkflowStatus (packages/core/src/project.ts)
 * — it already does exactly "one status + one 1:1-mapped column". No
 * category selector in the mockup's Kolom-kanban tab, so this defaults to
 * "in_progress" server-side (Backlog/Done stay reserved for the project
 * seed; ad hoc mid-flow columns are conventionally in-progress for
 * burndown correctness) — a deliberate simplification, not hidden.
 */
export const createBoardColumnFn = createServerFn({ method: "POST" })
  .validator(createBoardColumnSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      await requireProjectAdmin(tx, { ...ctx, projectId: data.projectId });
      return createWorkflowStatus(tx, { projectId: data.projectId, boardId: data.boardId, name: data.name, category: "in_progress" });
    });
  });

const updateBoardColumnSchema = z.object({
  projectId: z.string(),
  columnId: z.string(),
  name: z.string().min(1).optional(),
  color: z.string().optional(),
  wipLimit: z.number().int().positive().nullable().optional(),
});

export const updateBoardColumnFn = createServerFn({ method: "POST" })
  .validator(updateBoardColumnSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, async (tx) => {
      await requireProjectAdmin(tx, { ...ctx, projectId: data.projectId });
      await updateBoardColumn(tx, data);
    });
    return { ok: true } as const;
  });

const deleteBoardColumnSchema = z.object({ projectId: z.string(), columnId: z.string() });

export const deleteBoardColumnFn = createServerFn({ method: "POST" })
  .validator(deleteBoardColumnSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, async (tx) => {
      await requireProjectAdmin(tx, { ...ctx, projectId: data.projectId });
      await deleteBoardColumn(tx, data);
    });
    return { ok: true } as const;
  });

const reorderBoardColumnsSchema = z.object({ projectId: z.string(), boardId: z.string(), orderedColumnIds: z.array(z.string()) });

export const reorderBoardColumnsFn = createServerFn({ method: "POST" })
  .validator(reorderBoardColumnsSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, async (tx) => {
      await requireProjectAdmin(tx, { ...ctx, projectId: data.projectId });
      await reorderBoardColumns(tx, data);
    });
    return { ok: true } as const;
  });
