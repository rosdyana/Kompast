import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { createImportRun, markImportRunRunning, completeImportRun, failImportRun, listImportRuns, withAuthorizedTenant } from "@kompast/core";
import { fetchJiraIssues, runJiraImport, collectJiraEmails, type JiraIssue } from "@kompast/import";
import { requireAuthContext } from "../session";
import { resolveEmailsToUserIds, buildJiraAttachmentDownloader } from "../jira-import-helpers";

export const listImportRunsFn = createServerFn({ method: "GET" })
  .validator((projectId: string) => projectId)
  .handler(async ({ data: projectId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => listImportRuns(tx, projectId));
  });

const startJiraImportSchema = z.object({
  projectId: z.string(),
  boardId: z.string(),
  jiraBaseUrl: z.url(),
  jiraEmail: z.email(),
  jiraApiToken: z.string().min(1),
  jql: z.string().min(1),
  dryRun: z.boolean().optional(),
  fetchAttachments: z.boolean().optional(),
});

/**
 * Same shape as POST /api/v1/imports's "jira" branch (see that route's own
 * comment on why this runs synchronously, in two short transactions
 * around the JIRA network fetch, not one held open across it) — a
 * separate implementation rather than the REST route calling into this or
 * vice versa, matching the existing dual-adapter pattern elsewhere (e.g.
 * automation.rules.tsx vs server-fns/automation.ts) since the two differ
 * in how they resolve the project/board (REST takes a projectKey to
 * resolve; the UI already has projectId/boardId from the loaded board).
 */
export const startJiraImportFn = createServerFn({ method: "POST" })
  .validator(startJiraImportSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();

    const { importRunId } = await withAuthorizedTenant(ctx, (tx) =>
      createImportRun(tx, {
        organizationId: ctx.organizationId,
        projectId: data.projectId,
        source: "jira",
        dryRun: data.dryRun ?? false,
        config: { jiraBaseUrl: data.jiraBaseUrl, jql: data.jql },
        createdBy: ctx.userId,
      }),
    );
    await withAuthorizedTenant(ctx, (tx) => markImportRunRunning(tx, importRunId));

    let issues: JiraIssue[];
    try {
      issues = await fetchJiraIssues({ baseUrl: data.jiraBaseUrl, email: data.jiraEmail, apiToken: data.jiraApiToken }, data.jql);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await withAuthorizedTenant(ctx, (tx) => failImportRun(tx, importRunId, message));
      return { importRunId, report: null, error: message };
    }

    try {
      const report = await withAuthorizedTenant(ctx, async (tx) => {
        const emailMap = await resolveEmailsToUserIds(tx, ctx.organizationId, collectJiraEmails(issues));
        const report = await runJiraImport(tx, issues, {
          organizationId: ctx.organizationId,
          projectId: data.projectId,
          boardId: data.boardId,
          importRunId,
          actorUserId: ctx.userId,
          dryRun: data.dryRun ?? false,
          jiraBaseUrl: data.jiraBaseUrl,
          resolveUserId: (u) => (u?.emailAddress ? (emailMap.get(u.emailAddress.toLowerCase()) ?? null) : null),
          downloadAttachment: data.fetchAttachments ? buildJiraAttachmentDownloader(data.jiraEmail, data.jiraApiToken) : undefined,
        });
        await completeImportRun(tx, importRunId, report.counts, report.errors);
        return report;
      });
      return { importRunId, report, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await withAuthorizedTenant(ctx, (tx) => failImportRun(tx, importRunId, message));
      return { importRunId, report: null, error: message };
    }
  });
