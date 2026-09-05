import { createServerFn } from "@tanstack/react-start";
import { listThreads, listMessages, withAuthorizedTenant } from "@kompast/core";
import { requireAuthContext } from "../session";

export const listThreadsFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();
  return withAuthorizedTenant(ctx, (tx) => listThreads(tx, ctx.userId));
});

export const listMessagesFn = createServerFn({ method: "GET" })
  .validator((threadId: string) => threadId)
  .handler(async ({ data: threadId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => listMessages(tx, threadId));
  });
