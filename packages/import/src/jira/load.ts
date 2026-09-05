import { eq, schema } from "@kompast/db";
import {
  createIssue,
  updateIssue,
  addComment,
  logWork,
  linkIssues,
  attachIssueFile,
  recordHistoricalStatusChange,
  resolveExternalRef,
  upsertExternalRef,
  createWorkflowStatus,
  createIssueType,
  type Tx,
} from "@kompast/core";
import { adfToPlainText } from "./adf";
import { mapJiraPriority, mapJiraStatusCategory } from "./map";
import type { JiraIssue, JiraUser } from "./types";

export interface JiraLoadContext {
  organizationId: string;
  projectId: string;
  boardId: string;
  importRunId: string;
  /** Attributed as the actor for every backfilled row (history/comments/worklogs) — there's no real JIRA session to attribute to, and reporterId/authorId fall back to this when a JIRA user can't be resolved to a Kompast one. */
  actorUserId: string;
  dryRun: boolean;
  /** For building each issue's sourceUrl (e.g. "https://x.atlassian.net/browse/PROJ-1"). */
  jiraBaseUrl?: string;
  /**
   * Caller-supplied JIRA-user -> Kompast-user resolver (e.g. by email
   * match against project members) — this importer has no directory
   * sync of its own. Returning null leaves assignee unset / falls
   * reporter back to actorUserId.
   */
  resolveUserId?: (jiraUser: JiraUser | null) => string | null;
  /**
   * Opt-in attachment byte fetch — omitted, attachments are skipped
   * entirely (counted in the report, not silently dropped). Provided
   * separately from extraction because it requires a live authenticated
   * fetch per attachment even when the rest of extraction came from a
   * static export file.
   */
  downloadAttachment?: (url: string) => Promise<{ data: Buffer; contentType: string }>;
}

export interface JiraLoadReport {
  counts: {
    issuesCreated: number;
    issuesSkipped: number;
    statusesCreated: number;
    typesCreated: number;
    commentsCreated: number;
    worklogsCreated: number;
    linksCreated: number;
    attachmentsCreated: number;
    attachmentsSkipped: number;
    parentLinksResolved: number;
    historicalTransitionsRecorded: number;
  };
  statusMapping: { jiraStatusName: string; category: "todo" | "in_progress" | "done"; matchedExistingStatusId: string | null }[];
  typeMapping: { jiraTypeName: string; matchedExistingTypeId: string | null }[];
  errors: { issueKey: string; error: string }[];
}

function emptyReport(): JiraLoadReport {
  return {
    counts: {
      issuesCreated: 0,
      issuesSkipped: 0,
      statusesCreated: 0,
      typesCreated: 0,
      commentsCreated: 0,
      worklogsCreated: 0,
      linksCreated: 0,
      attachmentsCreated: 0,
      attachmentsSkipped: 0,
      parentLinksResolved: 0,
      historicalTransitionsRecorded: 0,
    },
    statusMapping: [],
    typeMapping: [],
    errors: [],
  };
}

/**
 * Extract -> map -> load for a batch of already-fetched JIRA issues.
 * Dry-run stops after building statusMapping/typeMapping — nothing is
 * written to issue/comment/worklog/link/attachment tables, only read
 * queries against the target project's existing statuses/types. A real
 * run applies exactly what the dry run would have shown; there is no
 * separate manual-override step for the status-category mapping this
 * pass (see README's P8 section) — JIRA's own statusCategory is trusted
 * directly.
 */
export async function runJiraImport(tx: Tx, issues: JiraIssue[], ctx: JiraLoadContext): Promise<JiraLoadReport> {
  const report = emptyReport();

  const existingTypes = await tx.select().from(schema.issueType).where(eq(schema.issueType.projectId, ctx.projectId));
  const existingStatuses = await tx.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, ctx.projectId));

  const typeIdByName = new Map(existingTypes.map((t) => [t.name.toLowerCase(), t.id]));
  const statusIdByName = new Map(existingStatuses.map((s) => [s.name.toLowerCase(), s.id]));

  const seenTypeNames = new Set<string>();
  const seenStatusNames = new Set<string>();
  for (const issue of issues) {
    const typeName = issue.fields.issuetype.name;
    if (!seenTypeNames.has(typeName.toLowerCase())) {
      seenTypeNames.add(typeName.toLowerCase());
      report.typeMapping.push({ jiraTypeName: typeName, matchedExistingTypeId: typeIdByName.get(typeName.toLowerCase()) ?? null });
    }
    const statusName = issue.fields.status.name;
    if (!seenStatusNames.has(statusName.toLowerCase())) {
      seenStatusNames.add(statusName.toLowerCase());
      report.statusMapping.push({
        jiraStatusName: statusName,
        category: mapJiraStatusCategory(issue.fields.status.statusCategory.key),
        matchedExistingStatusId: statusIdByName.get(statusName.toLowerCase()) ?? null,
      });
    }
  }

  if (ctx.dryRun) return report;

  for (const t of report.typeMapping) {
    if (t.matchedExistingTypeId) continue;
    const { typeId } = await createIssueType(tx, { projectId: ctx.projectId, name: t.jiraTypeName });
    typeIdByName.set(t.jiraTypeName.toLowerCase(), typeId);
    report.counts.typesCreated++;
  }
  for (const s of report.statusMapping) {
    if (s.matchedExistingStatusId) continue;
    const { statusId } = await createWorkflowStatus(tx, { projectId: ctx.projectId, boardId: ctx.boardId, name: s.jiraStatusName, category: s.category });
    statusIdByName.set(s.jiraStatusName.toLowerCase(), statusId);
    report.counts.statusesCreated++;
  }

  const resolveUser = ctx.resolveUserId ?? (() => null);
  const kompastIssueIdByJiraKey = new Map<string, string>();
  // Only issues actually CREATED in this run get passes 3-6 (comments/
  // worklogs/links/attachments/changelog) below — a skipped (already-
  // imported) issue keeps whatever those passes already gave it from
  // its original run. Without this, re-running the same import would
  // duplicate every comment/worklog/link on each subsequent run, which
  // is exactly the idempotence external_ref exists to prevent.
  const newlyCreatedKeys = new Set<string>();

  // Pass 1: create (or, on a re-run, recognize-and-skip) every issue.
  for (const issue of issues) {
    try {
      const existingRef = await resolveExternalRef(tx, ctx.organizationId, "jira", issue.key);
      if (existingRef) {
        kompastIssueIdByJiraKey.set(issue.key, existingRef.entityId);
        report.counts.issuesSkipped++;
        continue;
      }

      const reporterId = resolveUser(issue.fields.reporter) ?? ctx.actorUserId;
      const assigneeId = resolveUser(issue.fields.assignee) ?? undefined;

      const { issueId } = await createIssue(tx, {
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        typeId: typeIdByName.get(issue.fields.issuetype.name.toLowerCase())!,
        statusId: statusIdByName.get(issue.fields.status.name.toLowerCase())!,
        title: issue.fields.summary,
        reporterId,
        assigneeId,
        priority: mapJiraPriority(issue.fields.priority?.name),
        descriptionJson: issue.fields.description ? { text: adfToPlainText(issue.fields.description) } : undefined,
        labels: issue.fields.labels ?? [],
        estimateSeconds: issue.fields.timeoriginalestimate ?? undefined,
        dueDate: issue.fields.duedate ? new Date(issue.fields.duedate) : undefined,
        customFields: {
          jira: {
            originalKey: issue.key,
            fixVersions: (issue.fields.fixVersions ?? []).map((v) => v.name),
            components: (issue.fields.components ?? []).map((c) => c.name),
          },
        },
        createdAt: new Date(issue.fields.created),
        origin: "import",
      });

      kompastIssueIdByJiraKey.set(issue.key, issueId);
      newlyCreatedKeys.add(issue.key);
      await upsertExternalRef(tx, {
        organizationId: ctx.organizationId,
        source: "jira",
        sourceId: issue.key,
        sourceUrl: ctx.jiraBaseUrl ? `${ctx.jiraBaseUrl}/browse/${issue.key}` : undefined,
        entityType: "issue",
        entityId: issueId,
        importRunId: ctx.importRunId,
      });
      report.counts.issuesCreated++;
    } catch (err) {
      report.errors.push({ issueKey: issue.key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Pass 2: parent linkage — deferred until every issue in this batch exists, since a child can appear before its parent in JIRA's own result ordering.
  for (const issue of issues) {
    const parentKey = issue.fields.parent?.key;
    if (!parentKey) continue;
    const childId = kompastIssueIdByJiraKey.get(issue.key);
    if (!childId) continue; // this issue itself errored in pass 1
    try {
      const parentId = kompastIssueIdByJiraKey.get(parentKey) ?? (await resolveExternalRef(tx, ctx.organizationId, "jira", parentKey))?.entityId ?? null;
      if (!parentId) continue; // parent not part of this (or any prior) import — nothing to link to
      await updateIssue(tx, childId, { parentId, actorId: ctx.actorUserId, origin: "import" });
      report.counts.parentLinksResolved++;
    } catch (err) {
      report.errors.push({ issueKey: issue.key, error: `parent link: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // Pass 3-6: comments, worklogs, issue links, attachments, and changelog-
  // derived historical status transitions — ONLY for issues newly created
  // in THIS run. A skipped (already-imported) issue already got these from
  // whichever run first created it; redoing them on every re-run would
  // duplicate every comment/worklog/link each time the import is re-run.
  for (const issue of issues) {
    if (!newlyCreatedKeys.has(issue.key)) continue;
    const issueId = kompastIssueIdByJiraKey.get(issue.key)!;

    for (const c of issue.fields.comment?.comments ?? []) {
      try {
        await addComment(tx, {
          issueId,
          authorId: resolveUser(c.author) ?? ctx.actorUserId,
          bodyJson: { text: adfToPlainText(c.body) },
          origin: "import",
          createdAt: new Date(c.created),
        });
        report.counts.commentsCreated++;
      } catch (err) {
        report.errors.push({ issueKey: issue.key, error: `comment: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    for (const w of issue.fields.worklog?.worklogs ?? []) {
      try {
        await logWork(tx, {
          issueId,
          userId: resolveUser(w.author) ?? ctx.actorUserId,
          seconds: w.timeSpentSeconds,
          note: w.comment ? adfToPlainText(w.comment) : undefined,
          loggedAt: new Date(w.started),
        });
        report.counts.worklogsCreated++;
      } catch (err) {
        report.errors.push({ issueKey: issue.key, error: `worklog: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // Only the outward side is loaded — JIRA reports the same link from
    // both issues involved (this issue's outwardIssue, the other's
    // inwardIssue), so loading just one side avoids creating it twice.
    for (const link of issue.fields.issuelinks ?? []) {
      if (!link.outwardIssue) continue;
      const toIssueId = kompastIssueIdByJiraKey.get(link.outwardIssue.key) ?? (await resolveExternalRef(tx, ctx.organizationId, "jira", link.outwardIssue.key))?.entityId;
      if (!toIssueId) continue;
      try {
        await linkIssues(tx, { fromIssueId: issueId, toIssueId, type: mapLinkType(link.type.name) });
        report.counts.linksCreated++;
      } catch (err) {
        report.errors.push({ issueKey: issue.key, error: `link: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    if (ctx.downloadAttachment) {
      for (const att of issue.fields.attachment ?? []) {
        try {
          const { data, contentType } = await ctx.downloadAttachment(att.content);
          await attachIssueFile(tx, { issueId, uploaderId: ctx.actorUserId, fileName: att.filename, contentType: contentType || att.mimeType, data });
          report.counts.attachmentsCreated++;
        } catch (err) {
          report.errors.push({ issueKey: issue.key, error: `attachment ${att.filename}: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    } else {
      report.counts.attachmentsSkipped += issue.fields.attachment?.length ?? 0;
    }

    for (const history of issue.changelog?.histories ?? []) {
      for (const item of history.items) {
        if (item.field !== "status") continue;
        const fromStatusId = item.fromString ? (statusIdByName.get(item.fromString.toLowerCase()) ?? null) : null;
        const toStatusId = item.toString ? statusIdByName.get(item.toString.toLowerCase()) : undefined;
        if (!toStatusId) continue; // a status renamed/deleted since this changelog entry — nothing sensible to record it as
        try {
          await recordHistoricalStatusChange(tx, { issueId, actorId: ctx.actorUserId, fromStatusId, toStatusId, createdAt: new Date(history.created) });
          report.counts.historicalTransitionsRecorded++;
        } catch (err) {
          report.errors.push({ issueKey: issue.key, error: `changelog: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    }
  }

  return report;
}

function mapLinkType(jiraLinkTypeName: string): "blocks" | "relates" | "duplicates" | "clones" {
  const name = jiraLinkTypeName.toLowerCase();
  if (name.includes("block")) return "blocks";
  if (name.includes("duplicate")) return "duplicates";
  if (name.includes("clone")) return "clones";
  return "relates";
}
