import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { and, asc, desc, eq, inArray, schema, type Json } from "@kompast/db";
import {
  addComment,
  archiveIssue,
  restoreIssue,
  listComments,
  listAttachments,
  listCandidateEpics,
  listIssuePropertyDefinitions,
  listPriorityLevels,
  listSprints,
  getProjectByTeamAndKey,
  setWatching,
  updateIssue,
  updateIssueCustomField,
  withAuthorizedTenant,
  requireProjectAdmin,
  ForbiddenError,
} from "@kompast/core";
import { requireAuthContext } from "../session";
import { resolveIssue } from "../api-resolvers";

/**
 * Resolves a bare "KPT-123"-style key typed by a user (e.g. the docs page's
 * issue-linking input) with no team context available yet — reuses the
 * same ambiguity-aware resolver REST/MCP use (throws if the key now matches
 * more than one project across teams) rather than duplicating the lookup.
 */
export const resolveIssueByKeyFn = createServerFn({ method: "GET" })
  .validator((issueKey: string) => issueKey)
  .handler(async ({ data: issueKey }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      const { issue } = await resolveIssue(tx, ctx.organizationId, issueKey);
      return { issueId: issue.id };
    });
  });

export const getIssueDetailFn = createServerFn({ method: "GET" })
  .validator((input: { teamId: string; projectKey: string; issueKeySeq: number }) => input)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();

    return withAuthorizedTenant(ctx, async (tx) => {
      const project = await getProjectByTeamAndKey(tx, {
        organizationId: ctx.organizationId,
        teamId: data.teamId === "none" ? null : data.teamId,
        key: data.projectKey,
      });
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

      const [statuses, allTypes, propertyDefinitions, orgMembers, priorityLevels, candidateEpics, boardSprints] = await Promise.all([
        tx.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, project.id)).orderBy(asc(schema.workflowStatus.order)),
        tx.select().from(schema.issueType).where(eq(schema.issueType.projectId, project.id)).orderBy(asc(schema.issueType.order)),
        listIssuePropertyDefinitions(tx, project.id),
        // Full workspace member list (not just users already referenced by this
        // issue) — an assignee picker needs to offer everyone assignable, not
        // just whoever has touched this issue before.
        tx
          .select({ userId: schema.member.userId, name: schema.user.name })
          .from(schema.member)
          .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
          .where(eq(schema.member.organizationId, ctx.organizationId)),
        listPriorityLevels(tx, project.id),
        listCandidateEpics(tx, project.id, issue.id),
        // A project has exactly one board today (see every schema.board
        // insert site) — same first-row-destructure pattern as home.ts/
        // projects.ts, not a "what if multiple boards" branch.
        (async () => {
          const [board] = await tx.select().from(schema.board).where(eq(schema.board.projectId, project.id));
          return board ? listSprints(tx, board.id) : [];
        })(),
      ]);

      const canManageProject = await requireProjectAdmin(tx, { ...ctx, projectId: project.id })
        .then(() => true)
        .catch((err) => {
          if (err instanceof ForbiddenError) return false;
          throw err;
        });

      return {
        project,
        issue,
        type,
        status,
        comments,
        users,
        currentUserId: ctx.userId,
        isWatching,
        history,
        statuses,
        allTypes,
        attachments,
        propertyDefinitions,
        orgMembers,
        priorityLevels,
        candidateEpics,
        boardSprints,
        canManageProject,
      };
    });
  });

const archiveIssueSchema = z.object({ issueId: z.string() });

/** Soft delete, gated to project admin/lead — see packages/core/src/issue.ts's archiveIssue. */
export const archiveIssueFn = createServerFn({ method: "POST" })
  .validator(archiveIssueSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, async (tx) => {
      const [issue] = await tx.select({ projectId: schema.issue.projectId }).from(schema.issue).where(eq(schema.issue.id, data.issueId));
      if (!issue) throw new Error(`Issue ${data.issueId} not found`);
      await requireProjectAdmin(tx, { ...ctx, projectId: issue.projectId });
      await archiveIssue(tx, data.issueId, { actorId: ctx.userId, origin: "user" });
    });
    return { ok: true } as const;
  });

export const restoreIssueFn = createServerFn({ method: "POST" })
  .validator(archiveIssueSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, async (tx) => {
      const [issue] = await tx.select({ projectId: schema.issue.projectId }).from(schema.issue).where(eq(schema.issue.id, data.issueId));
      if (!issue) throw new Error(`Issue ${data.issueId} not found`);
      await requireProjectAdmin(tx, { ...ctx, projectId: issue.projectId });
      await restoreIssue(tx, data.issueId, { actorId: ctx.userId, origin: "user" });
    });
    return { ok: true } as const;
  });

const addCommentSchema = z.object({
  issueId: z.string(),
  bodyJson: z.array(z.record(z.string(), z.unknown())).min(1),
  parentCommentId: z.string().optional(),
});

export const addCommentFn = createServerFn({ method: "POST" })
  .validator(addCommentSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) =>
      addComment(tx, {
        issueId: data.issueId,
        authorId: ctx.userId,
        // Zod's z.record(z.string(), z.unknown()) infers Record<string,
        // unknown>, which — since `unknown` isn't structurally assignable to
        // Json — TS won't accept as Json[] even though every value it holds
        // is real jsonb-serializable data (BlockNote Block[]); same
        // intentionally-loose-validator-then-cast pattern as
        // updateIssueCustomFieldFn's `merged` below.
        bodyJson: data.bodyJson as Json,
        parentCommentId: data.parentCommentId,
      }),
    );
  });

const updateDescriptionSchema = z.object({ issueId: z.string(), descriptionJson: z.array(z.record(z.string(), z.unknown())).nullable() });

/**
 * Accepts the rich editor's real BlockNote block JSON directly (no more
 * server-side {text: string} wrapping) — description is now a full
 * BlockNote document, same shape addCommentFn's bodyJson uses.
 */
export const updateIssueDescriptionFn = createServerFn({ method: "POST" })
  .validator(updateDescriptionSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) =>
      // Same z.unknown()-vs-Json structural cast as addCommentFn's bodyJson above.
      updateIssue(tx, data.issueId, { descriptionJson: data.descriptionJson as Json, actorId: ctx.userId }),
    );
    return { ok: true } as const;
  });

const updateTitleSchema = z.object({ issueId: z.string(), title: z.string().min(1) });

export const updateIssueTitleFn = createServerFn({ method: "POST" })
  .validator(updateTitleSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => updateIssue(tx, data.issueId, { title: data.title, actorId: ctx.userId }));
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
  // priority is now a project-configurable key (see packages/core/src/
  // priority.ts), not a fixed enum — validity is enforced implicitly since
  // the UI only ever offers keys from listPriorityLevelsFn, same trust
  // level as statusId/typeId elsewhere in this file.
  priority: z.string().min(1),
});

export const updateIssuePriorityFn = createServerFn({ method: "POST" })
  .validator(updatePrioritySchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => updateIssue(tx, data.issueId, { priority: data.priority, actorId: ctx.userId }));
    return { ok: true } as const;
  });

const updateIssueDatesSchema = z.object({
  issueId: z.string(),
  startDate: z.iso.datetime().nullable().optional(),
  dueDate: z.iso.datetime().nullable().optional(),
});

export const updateIssueDatesFn = createServerFn({ method: "POST" })
  .validator(updateIssueDatesSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) =>
      updateIssue(tx, data.issueId, {
        startDate: data.startDate !== undefined ? (data.startDate ? new Date(data.startDate) : null) : undefined,
        dueDate: data.dueDate !== undefined ? (data.dueDate ? new Date(data.dueDate) : null) : undefined,
        actorId: ctx.userId,
      }),
    );
    return { ok: true } as const;
  });

const updateIssueEpicSchema = z.object({ issueId: z.string(), epicId: z.string().nullable() });

export const updateIssueEpicFn = createServerFn({ method: "POST" })
  .validator(updateIssueEpicSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => updateIssue(tx, data.issueId, { epicId: data.epicId, actorId: ctx.userId }));
    return { ok: true } as const;
  });

const updateIssueTypeSchema = z.object({ issueId: z.string(), typeId: z.string() });

export const updateIssueTypeFn = createServerFn({ method: "POST" })
  .validator(updateIssueTypeSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => updateIssue(tx, data.issueId, { typeId: data.typeId, actorId: ctx.userId }));
    return { ok: true } as const;
  });

const updateIssueLabelsSchema = z.object({ issueId: z.string(), labels: z.array(z.string()) });

export const updateIssueLabelsFn = createServerFn({ method: "POST" })
  .validator(updateIssueLabelsSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => updateIssue(tx, data.issueId, { labels: data.labels, actorId: ctx.userId }));
    return { ok: true } as const;
  });

const updateIssueStoryPointsSchema = z.object({ issueId: z.string(), storyPoints: z.number().nullable() });

export const updateIssueStoryPointsFn = createServerFn({ method: "POST" })
  .validator(updateIssueStoryPointsSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => updateIssue(tx, data.issueId, { storyPoints: data.storyPoints, actorId: ctx.userId }));
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
    await withAuthorizedTenant(ctx, (tx) => updateIssueCustomField(tx, data.issueId, data.key, data.value as Json, { actorId: ctx.userId }));
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
