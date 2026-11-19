import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { listThreads, listMessages, renameThread, deleteThread, withAuthorizedTenant, applyAskProposal, discardAskProposal } from "@kompast/core";
import { requireAuthContext } from "../session";
import { seedPageContentFromMarkdown } from "../seed-page-content";

export const listThreadsFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();
  return withAuthorizedTenant(ctx, (tx) => listThreads(tx, ctx.userId));
});

const renameThreadSchema = z.object({ threadId: z.string().min(1), title: z.string() });

/** Renames one of the caller's own chats. Empty titles are refused by core; the message reaches the browser via the public-error mapping. */
export const renameThreadFn = createServerFn({ method: "POST" })
  .validator(renameThreadSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => renameThread(tx, ctx.userId, data));
    return { ok: true } as const;
  });

/** Deletes one of the caller's own chats; its messages cascade. */
export const deleteThreadFn = createServerFn({ method: "POST" })
  .validator((threadId: string) => threadId)
  .handler(async ({ data: threadId }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => deleteThread(tx, ctx.userId, threadId));
    return { ok: true } as const;
  });

export const listMessagesFn = createServerFn({ method: "GET" })
  .validator((threadId: string) => threadId)
  .handler(async ({ data: threadId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => listMessages(tx, threadId));
  });

const proposalRefSchema = z.object({ messageId: z.string().min(1), proposalId: z.string().min(1) });

/** Approves a drafted change: runs the real mutation through core (origin "ai"). Errors reach the client via the global public-error mapping, like the other server fns. */
export const applyAskProposalFn = createServerFn({ method: "POST" })
  .validator(proposalRefSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return applyAskProposal(ctx, data, { seedPageBody: seedPageContentFromMarkdown });
  });

export const discardAskProposalFn = createServerFn({ method: "POST" })
  .validator(proposalRefSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return discardAskProposal(ctx, data);
  });
