import { eq, inArray, schema } from "@kompast/db";
import type { Tx } from "./types";
import type { SearchResult } from "./rag";

/**
 * Live facts about an issue, read at ask time (not from the indexed chunk
 * text, which can be stale — a status change doesn't reindex anything).
 * `key` is the human-facing KPT-42 form; `teamId` is null for a legacy
 * team-less project, which the UI links with the "none" placeholder.
 */
export interface IssueFacts {
  issueId: string;
  key: string;
  projectKey: string;
  keySeq: number;
  teamId: string | null;
  title: string;
  statusName: string | null;
  typeName: string | null;
  priorityName: string | null;
  assigneeName: string | null;
  sprint: { name: string; state: "future" | "active" | "closed" } | null;
  labels: string[];
}

export type RagEnrichment =
  | { kind: "issue"; issue: IssueFacts }
  /** A comment is cited by its own id, but its context and link point at the issue it belongs to. */
  | { kind: "comment"; issue: IssueFacts }
  | { kind: "page"; title: string; space: string };

export interface EnrichedCandidate {
  candidate: SearchResult;
  enrichment: RagEnrichment;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function present<T>(values: (T | null | undefined)[]): T[] {
  return values.filter((v): v is T => v !== null && v !== undefined);
}

/** Batch-loads the live facts for the given issue ids (RLS applies: an issue the caller can't see simply isn't in the map). */
export async function loadIssueFacts(tx: Tx, issueIds: string[]): Promise<Map<string, IssueFacts>> {
  const facts = new Map<string, IssueFacts>();
  if (issueIds.length === 0) return facts;

  // The join is RLS-scoped like everything else here: an issue the caller can't see simply doesn't come back.
  const rows = await tx
    .select({
      id: schema.issue.id,
      projectId: schema.issue.projectId,
      projectKey: schema.project.key,
      teamId: schema.project.teamId,
      keySeq: schema.issue.keySeq,
      title: schema.issue.title,
      statusId: schema.issue.statusId,
      typeId: schema.issue.typeId,
      priority: schema.issue.priority,
      assigneeId: schema.issue.assigneeId,
      sprintId: schema.issue.sprintId,
      labels: schema.issue.labels,
    })
    .from(schema.issue)
    .innerJoin(schema.project, eq(schema.project.id, schema.issue.projectId))
    .where(inArray(schema.issue.id, issueIds));
  if (rows.length === 0) return facts;

  const statusIds = unique(rows.map((r) => r.statusId));
  const typeIds = unique(rows.map((r) => r.typeId));
  const assigneeIds = unique(present(rows.map((r) => r.assigneeId)));
  const sprintIds = unique(present(rows.map((r) => r.sprintId)));
  const projectIds = unique(rows.map((r) => r.projectId));

  const statusNames = new Map<string, string>();
  if (statusIds.length) {
    const statuses = await tx.select({ id: schema.workflowStatus.id, name: schema.workflowStatus.name }).from(schema.workflowStatus).where(inArray(schema.workflowStatus.id, statusIds));
    for (const s of statuses) statusNames.set(s.id, s.name);
  }

  const typeNames = new Map<string, string>();
  if (typeIds.length) {
    const types = await tx.select({ id: schema.issueType.id, name: schema.issueType.name }).from(schema.issueType).where(inArray(schema.issueType.id, typeIds));
    for (const t of types) typeNames.set(t.id, t.name);
  }

  // issue.priority stores a stable per-project key (see packages/core/src/priority.ts); the display name lives on priority_level.
  const priorityNames = new Map<string, string>();
  if (projectIds.length) {
    const levels = await tx
      .select({ projectId: schema.priorityLevel.projectId, key: schema.priorityLevel.key, name: schema.priorityLevel.name })
      .from(schema.priorityLevel)
      .where(inArray(schema.priorityLevel.projectId, projectIds));
    for (const l of levels) priorityNames.set(`${l.projectId}:${l.key}`, l.name);
  }

  const assigneeNames = new Map<string, string>();
  if (assigneeIds.length) {
    const users = await tx.select({ id: schema.user.id, name: schema.user.name }).from(schema.user).where(inArray(schema.user.id, assigneeIds));
    for (const u of users) assigneeNames.set(u.id, u.name);
  }

  const sprints = new Map<string, { name: string; state: "future" | "active" | "closed" }>();
  if (sprintIds.length) {
    const sprintRows = await tx.select({ id: schema.sprint.id, name: schema.sprint.name, state: schema.sprint.state }).from(schema.sprint).where(inArray(schema.sprint.id, sprintIds));
    for (const s of sprintRows) sprints.set(s.id, { name: s.name, state: s.state });
  }

  for (const r of rows) {
    facts.set(r.id, {
      issueId: r.id,
      key: `${r.projectKey}-${r.keySeq}`,
      projectKey: r.projectKey,
      keySeq: r.keySeq,
      teamId: r.teamId,
      title: r.title,
      statusName: statusNames.get(r.statusId) ?? null,
      typeName: typeNames.get(r.typeId) ?? null,
      priorityName: priorityNames.get(`${r.projectId}:${r.priority}`) ?? null,
      assigneeName: r.assigneeId ? (assigneeNames.get(r.assigneeId) ?? null) : null,
      sprint: r.sprintId ? (sprints.get(r.sprintId) ?? null) : null,
      labels: r.labels ?? [],
    });
  }
  return facts;
}

async function loadPageFacts(tx: Tx, pageIds: string[]): Promise<Map<string, { title: string; space: string }>> {
  const pages = new Map<string, { title: string; space: string }>();
  if (pageIds.length === 0) return pages;

  const rows = await tx
    .select({
      id: schema.page.id,
      title: schema.page.title,
      projectId: schema.page.projectId,
      teamId: schema.page.teamId,
      privateOwnerId: schema.page.privateOwnerId,
    })
    .from(schema.page)
    .where(inArray(schema.page.id, pageIds));
  if (rows.length === 0) return pages;

  const projectIds = unique(present(rows.map((r) => r.projectId)));
  const teamIds = unique(present(rows.map((r) => r.teamId)));

  const projectKeys = new Map<string, string>();
  if (projectIds.length) {
    const projects = await tx.select({ id: schema.project.id, key: schema.project.key }).from(schema.project).where(inArray(schema.project.id, projectIds));
    for (const p of projects) projectKeys.set(p.id, p.key);
  }

  const teamNames = new Map<string, string>();
  if (teamIds.length) {
    const teams = await tx.select({ id: schema.team.id, name: schema.team.name }).from(schema.team).where(inArray(schema.team.id, teamIds));
    for (const t of teams) teamNames.set(t.id, t.name);
  }

  for (const r of rows) {
    let space: string;
    if (r.projectId) space = `project ${projectKeys.get(r.projectId) ?? ""}`.trim();
    else if (r.teamId) space = `team ${teamNames.get(r.teamId) ?? ""}`.trim();
    else if (r.privateOwnerId) space = "private";
    else space = "workspace";
    pages.set(r.id, { title: r.title, space });
  }
  return pages;
}

/**
 * Looks up the CURRENT row behind each retrieved chunk, in batches (one query
 * per entity kind, never one per candidate), using the caller's own
 * transaction so RLS decides what's visible. Any candidate whose entity row
 * doesn't come back — deleted since indexing, or not visible to this caller —
 * is DROPPED from the result, so it reaches neither the model's context nor
 * the citations. A comment is enriched via its issue (issue_comment.issue_id),
 * and dropped if that issue isn't visible.
 */
export async function enrichCandidates(tx: Tx, candidates: SearchResult[]): Promise<EnrichedCandidate[]> {
  if (candidates.length === 0) return [];

  const commentIds = unique(candidates.filter((c) => c.entityType === "comment").map((c) => c.entityId));
  const commentIssueId = new Map<string, string>();
  if (commentIds.length) {
    const comments = await tx
      .select({ id: schema.issueComment.id, issueId: schema.issueComment.issueId })
      .from(schema.issueComment)
      .where(inArray(schema.issueComment.id, commentIds));
    for (const c of comments) commentIssueId.set(c.id, c.issueId);
  }

  const issueIds = unique([
    ...candidates.filter((c) => c.entityType === "issue").map((c) => c.entityId),
    ...[...commentIssueId.values()],
  ]);
  const issues = await loadIssueFacts(tx, issueIds);

  const pageIds = unique(candidates.filter((c) => c.entityType === "page").map((c) => c.entityId));
  const pages = await loadPageFacts(tx, pageIds);

  const out: EnrichedCandidate[] = [];
  for (const candidate of candidates) {
    let enrichment: RagEnrichment | null = null;
    if (candidate.entityType === "issue") {
      const issue = issues.get(candidate.entityId);
      if (issue) enrichment = { kind: "issue", issue };
    } else if (candidate.entityType === "comment") {
      const issueId = commentIssueId.get(candidate.entityId);
      const issue = issueId ? issues.get(issueId) : undefined;
      if (issue) enrichment = { kind: "comment", issue };
    } else {
      const page = pages.get(candidate.entityId);
      if (page) enrichment = { kind: "page", title: page.title, space: page.space };
    }
    if (enrichment) out.push({ candidate, enrichment });
  }
  return out;
}
