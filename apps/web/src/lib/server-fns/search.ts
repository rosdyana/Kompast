import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { resolveIssueRef, searchWorkspace, withAuthorizedTenant } from "@kompast/core";
import { requireAuthContext } from "../session";

export const searchWorkspaceFn = createServerFn({ method: "GET" })
  .validator((query: string) => query)
  .handler(async ({ data: query }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => searchWorkspace(tx, ctx.organizationId, query));
  });

const resolveIssueRefSchema = z.object({
  /** "none" is the URL form of a project with no team. */
  teamId: z.string().min(1).max(200),
  projectKey: z.string().min(1).max(50),
  keySeq: z.number().int().positive(),
});

/** Backs the doc editor's paste-a-link-to-get-a-chip: null when the issue isn't there or isn't visible to the caller. */
export const resolveIssueRefFn = createServerFn({ method: "GET" })
  .validator(resolveIssueRefSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) =>
      resolveIssueRef(tx, {
        organizationId: ctx.organizationId,
        teamId: data.teamId === "none" ? null : data.teamId,
        projectKey: data.projectKey,
        keySeq: data.keySeq,
      }),
    );
  });
