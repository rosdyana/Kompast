import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { and, asc, desc, eq, inArray, schema, type Json } from "@kompast/db";
import {
  addComment,
  listComments,
  listAttachments,
  listIssuePropertyDefinitions,
  setWatching,
  updateIssue,
  withAuthorizedTenant,
} from "@kompast/core";
import { requireAuthContext } from "../session";

export const getIssueDetailFn = createServerFn({ method: "GET" })
  .validator((input: { projectKey: string; issueKeySeq: number }) => input)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();

    return withAuthorizedTenant(ctx, async (tx) => {
      const [project] = await tx
        .select()
        .from(schema.project)
        .where(and(eq(schema.project.organizationId, ctx.organizationId), eq(schema.project.key, data.projectKey.toUpperCase())));
      if (!project) throw new Error(`Project ${data.projectKey} not found`);

      const [issue] = await tx
        .select()
        .from(schema.issue)
        .where(and(eq(schema.issue.projectId, project.id), eq(schema.issue.keySeq, data.issueKeySeq)));
      if (!issue) throw new Error(`Issue ${data.projectKey}-${data.issueKeySeq} not found`);

      const [type, status, comments, history, attachments] = await Promise.all([
        tx.select().from(schema.issueType).where(eq(schema.issueType.id, issue.typeId)).then((r) => r[0]),
        tx.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.id, issue.statusId)).then((r) => r[0]),
        listComments(tx, issue.id),
        tx
          .select()
          .from(schema.issueHistory)
          .where(eq(schema.issueHistory.issueId, issue.id))
          .orderBy(desc(schema.issueHistory.createdAt))
          .limit(30),
        listAttachments(tx, issue.id),
      ]);

      const userIds = [
        ...new Set(
          [issue.assigneeId, issue.reporterId, ...comments.map((c) => c.authorId), ...history.map((h) => h.actorId)].filter(
            (v): v is string => !!v,
          ),
        ),
      ];
      const users = userIds.length > 0 ? await tx.select().from(schema.user).where(inArray(schema.user.id, userIds)) : [];

      const isWatching = await tx
        .select()
        .from(schema.issueWatcher)
        .where(and(eq(schema.issueWatcher.issueId, issue.id), eq(schema.issueWatcher.userId, ctx.userId)))
        .then((r) => r.length > 0);

      const [statuses, allTypes, propertyDefinitions, orgMembers] = await Promise.all([
        tx.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, project.id)).orderBy(asc(schema.workflowStatus.order)),
        tx.select().from(schema.issueType).where(eq(schema.issueType.projectId, project.id)),
        listIssuePropertyDefinitions(tx, project.id),
        // Full workspace member list (not just users already referenced by this
        // issue) — an assignee picker needs to offer everyone assignable, not
        // just whoever has touched this issue before.
        tx
          .select({ userId: schema.member.userId, name: schema.user.name })
          .from(schema.member)
          .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
          .where(eq(schema.member.organizationId, ctx.organizationId)),
      ]);

      return { project, issue, type, status, comments, users, isWatching, history, statuses, allTypes, attachments, propertyDefinitions, orgMembers };
    });
  });

const addCommentSchema = z.object({ issueId: z.string(), text: z.string().min(1) });

export const addCommentFn = createServerFn({ method: "POST" })
  .validator(addCommentSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) =>
      addComment(tx, { issueId: data.issueId, authorId: ctx.userId, bodyJson: { text: data.text } }),
    );
  });

const updateDescriptionSchema = z.object({ issueId: z.string(), description: z.string() });

/**
 * The issue detail page had no description display/edit UI at all before
 * this (a pre-existing P1/P2 gap — description was only ever settable via
 * REST/MCP create) — this is the minimal write path for it, using the
 * same {text: string} descriptionJson shape REST/MCP already use (see
 * apps/web/src/routes/api/v1/issues.tsx), not a full BlockNote document.
 */
export const updateIssueDescriptionFn = createServerFn({ method: "POST" })
  .validator(updateDescriptionSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) =>
      updateIssue(tx, data.issueId, { descriptionJson: data.description.trim() ? { text: data.description } : null, actorId: ctx.userId }),
    );
    return { ok: true } as const;
  });

const updateAssigneeSchema = z.object({ issueId: z.string(), assigneeId: z.string().nullable() });

export const updateIssueAssigneeFn = createServerFn({ method: "POST" })
  .validator(updateAssigneeSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => updateIssue(tx, data.issueId, { assigneeId: data.assigneeId, actorId: ctx.userId }));
    return { ok: true } as const;
  });

const updatePrioritySchema = z.object({
  issueId: z.string(),
  priority: z.enum(["lowest", "low", "medium", "high", "highest"]),
});

export const updateIssuePriorityFn = createServerFn({ method: "POST" })
  .validator(updatePrioritySchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => updateIssue(tx, data.issueId, { priority: data.priority, actorId: ctx.userId }));
    return { ok: true } as const;
  });

const updateCustomFieldSchema = z.object({
  issueId: z.string(),
  key: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
});

/**
 * issue.customFields is a full-replace column (see packages/core/src/
 * issue.ts's updateIssue) — there's no partial jsonb merge at the DB layer,
 * so setting just ONE property's value means reading the current blob,
 * merging this one key in, and writing the whole object back. Never
 * touches any other key.
 */
export const updateIssueCustomFieldFn = createServerFn({ method: "POST" })
  .validator(updateCustomFieldSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, async (tx) => {
      const [current] = await tx.select({ customFields: schema.issue.customFields }).from(schema.issue).where(eq(schema.issue.id, data.issueId));
      if (!current) throw new Error(`Issue ${data.issueId} not found`);
      const merged = { ...(current.customFields as Record<string, Json> | null), [data.key]: data.value } as Json;
      await updateIssue(tx, data.issueId, { customFields: merged, actorId: ctx.userId });
    });
    return { ok: true } as const;
  });

const toggleWatchSchema = z.object({ issueId: z.string(), watching: z.boolean() });

export const toggleWatchFn = createServerFn({ method: "POST" })
  .validator(toggleWatchSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) =>
      setWatching(tx, { issueId: data.issueId, userId: ctx.userId, watching: data.watching }),
    );
    return { ok: true } as const;
  });
