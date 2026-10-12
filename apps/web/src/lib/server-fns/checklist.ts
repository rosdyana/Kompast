import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { addChecklistItem, deleteChecklistItem, listChecklistItems, moveChecklistItem, updateChecklistItem, withAuthorizedTenant } from "@kompast/core";
import { requireAuthContext } from "../session";

export const listChecklistFn = createServerFn({ method: "GET" })
  .validator((issueId: string) => issueId)
  .handler(async ({ data: issueId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => listChecklistItems(tx, issueId));
  });

export const addChecklistItemFn = createServerFn({ method: "POST" })
  .validator(z.object({ issueId: z.string(), text: z.string().min(1).max(500) }))
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => addChecklistItem(tx, { issueId: data.issueId, text: data.text, createdBy: ctx.userId }));
  });

export const updateChecklistItemFn = createServerFn({ method: "POST" })
  .validator(z.object({ itemId: z.string(), text: z.string().min(1).max(500).optional(), done: z.boolean().optional() }))
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => updateChecklistItem(tx, data));
    return { ok: true } as const;
  });

export const deleteChecklistItemFn = createServerFn({ method: "POST" })
  .validator(z.object({ itemId: z.string() }))
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => deleteChecklistItem(tx, data.itemId));
    return { ok: true } as const;
  });

export const moveChecklistItemFn = createServerFn({ method: "POST" })
  .validator(z.object({ itemId: z.string(), direction: z.enum(["up", "down"]) }))
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => moveChecklistItem(tx, data));
    return { ok: true } as const;
  });
