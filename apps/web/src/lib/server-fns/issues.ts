import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { moveIssue as moveIssueCore, createIssue as createIssueCore, withAuthorizedTenant } from "@kompast/core";
import { requireAuthContext } from "../session";

const moveIssueSchema = z.object({
  issueId: z.string(),
  toStatusId: z.string(),
  beforeIssueId: z.string().optional(),
  afterIssueId: z.string().optional(),
});

export const moveIssueFn = createServerFn({ method: "POST" })
  .validator(moveIssueSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) =>
      moveIssueCore(tx, {
        issueId: data.issueId,
        toStatusId: data.toStatusId,
        beforeIssueId: data.beforeIssueId,
        afterIssueId: data.afterIssueId,
        actorId: ctx.userId,
        origin: "user",
      }),
    );
    return { ok: true } as const;
  });

const createIssueSchema = z.object({
  projectId: z.string(),
  typeId: z.string(),
  statusId: z.string(),
  title: z.string().min(1),
});

export const createIssueFn = createServerFn({ method: "POST" })
  .validator(createIssueSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) =>
      createIssueCore(tx, {
        organizationId: ctx.organizationId,
        projectId: data.projectId,
        typeId: data.typeId,
        statusId: data.statusId,
        title: data.title,
        reporterId: ctx.userId,
      }),
    );
  });
