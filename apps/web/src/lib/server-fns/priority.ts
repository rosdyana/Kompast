import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import {
  createPriorityLevel,
  deletePriorityLevel,
  listPriorityLevels,
  reorderPriorityLevels,
  requireProjectAccess,
  requireProjectAdmin,
  updatePriorityLevel,
  withAuthorizedTenant,
} from "@kompast/core";
import { requireAuthContext } from "../session";

export const listPriorityLevelsFn = createServerFn({ method: "GET" })
  .validator((projectId: string) => projectId)
  .handler(async ({ data: projectId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      await requireProjectAccess(tx, { ...ctx, projectId });
      return listPriorityLevels(tx, projectId);
    });
  });

const createPriorityLevelSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1),
  color: z.string().min(1),
});

export const createPriorityLevelFn = createServerFn({ method: "POST" })
  .validator(createPriorityLevelSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      await requireProjectAdmin(tx, { ...ctx, projectId: data.projectId });
      return createPriorityLevel(tx, data);
    });
  });

const updatePriorityLevelSchema = z.object({
  projectId: z.string(),
  levelId: z.string(),
  name: z.string().min(1).optional(),
  color: z.string().min(1).optional(),
  order: z.number().int().optional(),
});

export const updatePriorityLevelFn = createServerFn({ method: "POST" })
  .validator(updatePriorityLevelSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, async (tx) => {
      await requireProjectAdmin(tx, { ...ctx, projectId: data.projectId });
      await updatePriorityLevel(tx, data);
    });
    return { ok: true } as const;
  });

const reorderPriorityLevelsSchema = z.object({ projectId: z.string(), orderedLevelIds: z.array(z.string()) });

export const reorderPriorityLevelsFn = createServerFn({ method: "POST" })
  .validator(reorderPriorityLevelsSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, async (tx) => {
      await requireProjectAdmin(tx, { ...ctx, projectId: data.projectId });
      await reorderPriorityLevels(tx, data);
    });
    return { ok: true } as const;
  });

const deletePriorityLevelSchema = z.object({ projectId: z.string(), levelId: z.string() });

export const deletePriorityLevelFn = createServerFn({ method: "POST" })
  .validator(deletePriorityLevelSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, async (tx) => {
      await requireProjectAdmin(tx, { ...ctx, projectId: data.projectId });
      await deletePriorityLevel(tx, data);
    });
    return { ok: true } as const;
  });
