import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { eq, schema } from "@kompast/db";
import {
  createPage,
  getSprint,
  getSprintMinutesPage,
  getStandupDigest,
  renderStandupMarkdown,
  requirePageAccess,
  NotFoundError,
  withAuthorizedTenant,
} from "@kompast/core";
import { requireAuthContext } from "../session";
import { seedPageContentFromMarkdown } from "../seed-page-content";

const getStandupDigestSchema = z.object({
  sprintId: z.string().min(1),
  since: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "since must be an ISO date-time"),
});

export const getStandupDigestFn = createServerFn({ method: "GET" })
  .validator(getStandupDigestSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => getStandupDigest(tx, { sprintId: data.sprintId, since: new Date(data.since) }));
  });

const memberSchema = z.object({
  name: z.string().max(200),
  did: z.array(z.string().max(5000)).max(200),
  today: z.array(z.string().max(5000)).max(200),
  blockers: z.string().max(5000),
  notes: z.string().max(5000),
  skipped: z.boolean(),
});

const finishStandupSchema = z.object({
  sprintId: z.string().min(1),
  /** Client local date, "YYYY-MM-DD" — goes into the page title, so it's format-checked. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  members: z.array(memberSchema).max(100),
  durationSec: z.number().min(0).max(24 * 60 * 60),
});

/**
 * Saves the standup as a NEW child page under the sprint's minutes doc
 * (or, when the sprint has no minutes doc, a top-level page in the board's
 * project). A brand-new page can't race a live collab connection, which is
 * why this creates a page rather than appending to the minutes doc itself.
 * `sprintId` is deliberately not passed to createPage: getSprintMinutesPage
 * selects by sprintId, so a second match would make it return an arbitrary page.
 */
export const finishStandupFn = createServerFn({ method: "POST" })
  .validator(finishStandupSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      const sprint = await getSprint(tx, data.sprintId);
      if (!sprint) throw new NotFoundError(`Sprint ${data.sprintId} not found`);

      const minutes = await getSprintMinutesPage(tx, data.sprintId);
      let projectId: string | undefined;
      if (minutes) {
        await requirePageAccess(tx, minutes.id, ctx, "edit");
      } else {
        const [board] = await tx.select({ projectId: schema.board.projectId }).from(schema.board).where(eq(schema.board.id, sprint.boardId));
        if (!board) throw new NotFoundError(`Board for sprint ${data.sprintId} not found`);
        projectId = board.projectId;
      }

      // Parent set → the child inherits the parent's space, so projectId is only passed when there's no parent (resolveSpace rejects a mismatch).
      const page = await createPage(tx, {
        organizationId: ctx.organizationId,
        parentPageId: minutes?.id ?? null,
        projectId,
        title: `Standup — ${data.date}`,
        actorUserId: ctx.userId,
      });

      const markdown = renderStandupMarkdown({ date: data.date, members: data.members, durationSec: data.durationSec });
      await seedPageContentFromMarkdown(tx, page.id, markdown, ctx.organizationId);
      return { pageId: page.id };
    });
  });
