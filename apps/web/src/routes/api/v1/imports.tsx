import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { createImportRun, markImportRunRunning, completeImportRun, failImportRun, listImportRuns, withAuthorizedTenant } from "@kompast/core";
import { fetchJiraIssues, runJiraImport, collectJiraEmails, type JiraIssue } from "@kompast/import";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveProject, resolveBoardForProject } from "@/lib/api-resolvers";
import { resolveEmailsToUserIds, buildJiraAttachmentDownloader } from "@/lib/jira-import-helpers";

const startImportSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("jira"),
    projectKey: z.string(),
    jiraBaseUrl: z.url(),
    jiraEmail: z.email(),
    jiraApiToken: z.string().min(1),
    /** Required, not defaulted from projectKey — a Kompast project key (e.g. "KPT") has no necessary relationship to the source JIRA project's own key. */
    jql: z.string().min(1),
    dryRun: z.boolean().optional(),
    fetchAttachments: z.boolean().optional(),
  }),
]);

export const Route = createFileRoute("/api/v1/imports")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:read", "api");
          const projectKey = new URL(request.url).searchParams.get("projectKey");
          if (!projectKey) return jsonResponse({ type: "about:blank", title: "Bad Request", status: 400, detail: "projectKey query param is required" }, 400);

          return withAuthorizedTenant(ctx, async (tx) => {
            const project = await resolveProject(tx, ctx.organizationId, projectKey);
            const runs = await listImportRuns(tx, project.id);
            return jsonResponse({ data: runs });
          });
        }),

      /**
       * Runs synchronously in this request — no background job/queue for
       * imports exists yet. Fine for an admin-triggered, infrequent
       * backfill; a very large JIRA project may exceed a typical reverse
       * proxy's request timeout, a known, documented limitation (see
       * README's P8 section) rather than something this pass builds
       * around. The JIRA network fetch deliberately happens BETWEEN two
       * short withAuthorizedTenant transactions, not inside one held open
       * for the whole fetch.
       */
      POST: async ({ request }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:write", "api");
          const body = startImportSchema.parse(await request.json());

          const { project, board, importRunId } = await withAuthorizedTenant(ctx, async (tx) => {
            const project = await resolveProject(tx, ctx.organizationId, body.projectKey);
            const board = await resolveBoardForProject(tx, project.id);
            const { importRunId } = await createImportRun(tx, {
              organizationId: ctx.organizationId,
              projectId: project.id,
              source: "jira",
              dryRun: body.dryRun ?? false,
              config: { jiraBaseUrl: body.jiraBaseUrl, jql: body.jql },
              createdBy: ctx.userId,
            });
            await markImportRunRunning(tx, importRunId);
            return { project, board, importRunId };
          });

          let issues: JiraIssue[];
          try {
            issues = await fetchJiraIssues({ baseUrl: body.jiraBaseUrl, email: body.jiraEmail, apiToken: body.jiraApiToken }, body.jql);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await withAuthorizedTenant(ctx, (tx) => failImportRun(tx, importRunId, message));
            return jsonResponse({ importRunId, error: message }, 502);
          }

          try {
            const report = await withAuthorizedTenant(ctx, async (tx) => {
              const emailMap = await resolveEmailsToUserIds(tx, ctx.organizationId, collectJiraEmails(issues));
              const report = await runJiraImport(tx, issues, {
                organizationId: ctx.organizationId,
                projectId: project.id,
                boardId: board.id,
                importRunId,
                actorUserId: ctx.userId,
                dryRun: body.dryRun ?? false,
                jiraBaseUrl: body.jiraBaseUrl,
                resolveUserId: (u) => (u?.emailAddress ? (emailMap.get(u.emailAddress.toLowerCase()) ?? null) : null),
                downloadAttachment: body.fetchAttachments ? buildJiraAttachmentDownloader(body.jiraEmail, body.jiraApiToken) : undefined,
              });
              await completeImportRun(tx, importRunId, report.counts, report.errors);
              return report;
            });
            return jsonResponse({ importRunId, report }, 201);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await withAuthorizedTenant(ctx, (tx) => failImportRun(tx, importRunId, message));
            return jsonResponse({ importRunId, error: message }, 500);
          }
        }),
    },
  },
});
