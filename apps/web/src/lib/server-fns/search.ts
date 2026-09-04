import { createServerFn } from "@tanstack/react-start";
import { searchWorkspace, withAuthorizedTenant } from "@kompast/core";
import { requireAuthContext } from "../session";

export const searchWorkspaceFn = createServerFn({ method: "GET" })
  .validator((query: string) => query)
  .handler(async ({ data: query }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => searchWorkspace(tx, ctx.organizationId, query));
  });
