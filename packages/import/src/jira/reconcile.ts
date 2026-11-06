import { and, eq, inArray, schema, sql, type Json } from "@kompast/db";
import { listIssuePropertyDefinitions, listPriorityLevels, type JiraMigrationMapping, type Tx } from "@kompast/core";
import type { JiraDiscovery } from "./discover";
import { convertJiraValue, JIRA_CORE_FIELD_TYPE, type JiraValueConversion } from "./fields";
import { extractJiraSprints, resolvePriorityKey } from "./map";
import type { PreparedFieldTarget } from "./load";
import { currentJiraSprintIdOf, orderJiraSprints, type SprintRank } from "./sprint-order";
import type { JiraIssue, JiraSprint, JiraUser } from "./types";

/**
 * The reconciliation report: a read-only comparison of a finished migration's JIRA project with what Kompast holds.
 * It changes no data on either side. Each category counts its units: `jira` and `kompast` are what each side has,
 * `matched` is the units that agree, and `explained`/`unexplained` count the differences (one entry each).
 */

export const RECONCILE_CATEGORIES = [
  "issues",
  "keyNumbers",
  "title",
  "status",
  "type",
  "priority",
  "assignee",
  "parent",
  "sprint",
  "comments",
  "worklogs",
  "attachments",
  "links",
  "watchers",
  "fields",
  "inlineMedia",
  "sprints",
  "missingInJira",
] as const;
export type ReconcileCategory = (typeof RECONCILE_CATEGORIES)[number];

export interface ReconcileTally {
  jira: number;
  kompast: number;
  matched: number;
  explained: number;
  unexplained: number;
}
export type ReconcileCounts = Record<ReconcileCategory, ReconcileTally>;

export interface ReconcileDifference {
  category: ReconcileCategory;
  issueKey: string;
  jira: string | number | null;
  kompast: string | number | null;
  /** "explained:<code>" when the difference has a known cause, else "unexplained". */
  reason: `explained:${string}` | "unexplained";
  detail?: string;
}

/** The most differences one run keeps. Counts still include every difference past it; `truncated` counts those. */
export const RECONCILE_DIFFERENCE_CAP = 20_000;

/** The fields a reconcile page reads from JIRA beyond the fixed list (see reconcileFieldList). */
const FIXED_FIELDS = ["key", "summary", "status", "issuetype", "assignee", "reporter", "priority", "parent", "comment", "worklog", "attachment", "issuelinks", "watches", "labels", "duedate", "resolutiondate"];

export function emptyReconcileCounts(): ReconcileCounts {
  const zero = (): ReconcileTally => ({ jira: 0, kompast: 0, matched: 0, explained: 0, unexplained: 0 });
  return Object.fromEntries(RECONCILE_CATEGORIES.map((c) => [c, zero()])) as ReconcileCounts;
}

/** Whether every category has no unexplained difference. */
export function reconcileIsClean(counts: ReconcileCounts): boolean {
  return RECONCILE_CATEGORIES.every((c) => counts[c].unexplained === 0);
}

/** The collector a run writes into. Counts and differences live here, so a tick's work is a plain merge. */
export class ReconcileLog {
  constructor(
    readonly counts: ReconcileCounts,
    readonly differences: ReconcileDifference[],
    public truncated: number,
  ) {}

  tally(category: ReconcileCategory, delta: { jira?: number; kompast?: number; matched?: number }): void {
    const t = this.counts[category];
    t.jira += delta.jira ?? 0;
    t.kompast += delta.kompast ?? 0;
    t.matched += delta.matched ?? 0;
  }

  difference(d: ReconcileDifference): void {
    const t = this.counts[d.category];
    if (d.reason === "unexplained") t.unexplained++;
    else t.explained++;
    if (this.differences.length < RECONCILE_DIFFERENCE_CAP) this.differences.push(d);
    else this.truncated++;
  }
}

// ── Environment (read once per tick) ────────────────────────────────────────

export interface ReconcileEnv {
  organizationId: string;
  projectId: string;
  boardId: string;
  projectKey: string;
  lastSyncedAt: Date | null;
  statusNameById: Map<string, string>;
  statusIdByName: Map<string, string>;
  typeNameById: Map<string, string>;
  typeIdByName: Map<string, string>;
  priorityLevels: { key: string; name: string }[];
  mapping: JiraMigrationMapping;
  /** Mapped people: JIRA account id -> Kompast member. */
  mappedUserByAccount: Map<string, string>;
  /** Former members: JIRA account id -> their placeholder user (external_ref, entity "user"). */
  formerUserByAccount: Map<string, string>;
  /** The fields the loader writes, resolved to their targets the way the loader resolves them (never creates). */
  fieldTargets: PreparedFieldTarget[] | undefined;
  /** Board sprints that Kompast imported (external_ref "sprint:<jira id>"), by JIRA sprint id. */
  sprintRefs: Map<number, { sprintId: string; name: string; state: string; startAt: Date | null }>;
  /** The JIRA board sprints' place in the loader's sprint order (orderJiraSprints), by JIRA sprint id. */
  sprintOrder: Map<number, number>;
  /** Key numbers an earlier run renumbered (its notes say so). */
  renumbered: Set<string>;
}

export interface ReconcileEnvInput {
  organizationId: string;
  projectId: string;
  boardId: string;
  projectKey: string;
  lastSyncedAt: Date | null;
  discovery: JiraDiscovery;
  mapping: JiraMigrationMapping;
  renumbered: string[];
}

/**
 * The reference data a comparison needs: the project's statuses, types, priorities and properties, the mapping's people
 * (mapped members, and former members' placeholder users), the imported sprints, and the renumbered keys. Reads only.
 */
export async function loadReconcileEnv(tx: Tx, input: ReconcileEnvInput): Promise<ReconcileEnv> {
  const statuses = await tx.select({ id: schema.workflowStatus.id, name: schema.workflowStatus.name }).from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, input.projectId));
  const types = await tx.select({ id: schema.issueType.id, name: schema.issueType.name }).from(schema.issueType).where(eq(schema.issueType.projectId, input.projectId));
  const properties = await listIssuePropertyDefinitions(tx, input.projectId);
  const priorityLevels = (await listPriorityLevels(tx, input.projectId)).map((l) => ({ key: l.key, name: l.name }));

  const formerAccounts = input.mapping.people.filter((p) => p.action === "former").map((p) => p.accountId);
  const formerRefs = formerAccounts.length
    ? await tx
        .select({ sourceId: schema.externalRef.sourceId, entityId: schema.externalRef.entityId })
        .from(schema.externalRef)
        .where(
          and(
            eq(schema.externalRef.organizationId, input.organizationId),
            eq(schema.externalRef.source, "jira"),
            eq(schema.externalRef.entityType, "user"),
            inArray(schema.externalRef.sourceId, formerAccounts),
          ),
        )
    : [];

  const sprintRows = await tx
    .select({ sourceId: schema.externalRef.sourceId, sprintId: schema.sprint.id, name: schema.sprint.name, state: schema.sprint.state, startAt: schema.sprint.startAt })
    .from(schema.externalRef)
    .innerJoin(schema.sprint, eq(schema.sprint.id, schema.externalRef.entityId))
    .where(
      and(
        eq(schema.externalRef.organizationId, input.organizationId),
        eq(schema.externalRef.source, "jira"),
        eq(schema.externalRef.entityType, "sprint"),
        eq(schema.sprint.boardId, input.boardId),
      ),
    );

  const statusNameById = new Map(statuses.map((s) => [s.id, s.name]));
  const typeNameById = new Map(types.map((t) => [t.id, t.name]));
  const sprintRefs = new Map<number, { sprintId: string; name: string; state: string; startAt: Date | null }>();
  for (const r of sprintRows) {
    const jiraId = Number(r.sourceId.replace(/^sprint:/, ""));
    if (Number.isFinite(jiraId)) sprintRefs.set(jiraId, { sprintId: r.sprintId, name: r.name, state: r.state, startAt: r.startAt });
  }

  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    boardId: input.boardId,
    projectKey: input.projectKey,
    lastSyncedAt: input.lastSyncedAt,
    statusNameById,
    statusIdByName: new Map(statuses.map((s) => [s.name.toLowerCase(), s.id])),
    typeNameById,
    typeIdByName: new Map(types.map((t) => [t.name.toLowerCase(), t.id])),
    priorityLevels,
    mapping: input.mapping,
    mappedUserByAccount: new Map(input.mapping.people.flatMap((p) => (p.action === "map" && p.kompastUserId ? [[p.accountId, p.kompastUserId] as const] : []))),
    formerUserByAccount: new Map(formerRefs.map((r) => [r.sourceId, r.entityId])),
    fieldTargets: reconcileFieldTargets(input.mapping, properties.map((p) => ({ key: p.key, name: p.name, type: p.type, isCore: p.isCore }))),
    sprintRefs,
    sprintOrder: new Map(orderJiraSprints(input.discovery.sprints).map((s, order) => [s.id, order])),
    renumbered: new Set(input.renumbered),
  };
}

/** The mapping's fields as write targets. Mirrors prepareJiraImport without creating anything: a field whose property is missing is left out. */
export function reconcileFieldTargets(
  mapping: JiraMigrationMapping,
  properties: { key: string; name: string; type: string; isCore: boolean }[],
): PreparedFieldTarget[] | undefined {
  if (!mapping.fields) return undefined;
  const targets: PreparedFieldTarget[] = [];
  for (const f of mapping.fields) {
    if (f.action === "skip") continue;
    const base = { jiraFieldId: f.jiraFieldId, jiraName: f.jiraName };
    if (f.action === "core" && f.coreField) {
      targets.push({ ...base, kind: "core", coreField: f.coreField, type: JIRA_CORE_FIELD_TYPE[f.coreField] });
      continue;
    }
    if (f.propertyKey) {
      const existing = properties.find((p) => !p.isCore && p.key === f.propertyKey);
      if (!existing) continue;
      targets.push({ ...base, kind: "property", propertyKey: existing.key, type: existing.type as PreparedFieldTarget["type"], ...(f.transform && existing.type === "number" ? { transform: f.transform } : {}) });
      continue;
    }
    if (!f.create) continue;
    const wanted = f.create;
    const reuse = properties.find((p) => !p.isCore && p.type === wanted.type && p.name.trim().toLowerCase() === wanted.name.trim().toLowerCase());
    if (!reuse) continue;
    targets.push({ ...base, kind: "property", propertyKey: reuse.key, type: reuse.type as PreparedFieldTarget["type"], ...(f.transform && reuse.type === "number" ? { transform: f.transform } : {}) });
  }
  return targets;
}

/** The fields one reconcile page asks JIRA for: the fixed list, the Sprint field, and every mapped field that isn't skipped. */
export function reconcileFieldList(discovery: JiraDiscovery, mapping: JiraMigrationMapping): string {
  const sprintFields = (discovery.fields ?? []).filter((f) => f.schemaCustom?.includes("gh-sprint") || f.name === "Sprint").map((f) => f.id);
  const mapped = (mapping.fields ?? []).filter((f) => f.action !== "skip").map((f) => f.jiraFieldId);
  return [...new Set([...FIXED_FIELDS, ...sprintFields, ...mapped])].join(",");
}

/** The JQL a reconcile reads with: every issue of the project, by key. */
export function reconcileJql(projectKey: string): string {
  return `project = "${projectKey.replace(/"/g, '\\"')}" ORDER BY key`;
}

/** The renumbered keys of earlier runs: notes that say "renumbered to ...", from every run but reconciles. */
export function renumberedKeysOf(runs: { config: Json; notes: Json | null }[]): string[] {
  const keys = new Set<string>();
  for (const run of runs) {
    if ((run.config as { mode?: unknown } | null)?.mode === "reconcile") continue;
    const notes = run.notes;
    const list = Array.isArray(notes) ? notes : notes && typeof notes === "object" ? ((notes as { issueNotes?: unknown }).issueNotes as unknown[] | undefined) ?? [] : [];
    for (const n of list) {
      const entry = n as { issueKey?: unknown; note?: unknown };
      if (typeof entry.issueKey === "string" && typeof entry.note === "string" && entry.note.startsWith("renumbered to")) keys.add(entry.issueKey);
    }
  }
  return [...keys];
}

// ── Page snapshot (one query per table per page) ────────────────────────────

export interface ReconcileIssueRow {
  id: string;
  keySeq: number;
  title: string;
  statusId: string;
  typeId: string;
  priority: string;
  assigneeId: string | null;
  parentId: string | null;
  sprintId: string | null;
  storyPoints: number | null;
  estimateSeconds: number | null;
  startDate: Date | null;
  dueDate: Date | null;
  descriptionJson: Json | null;
  customFields: Json;
}

export interface ReconcileSnapshot {
  /** JIRA key -> Kompast issue id, for the page's issues, their parents and their link targets. */
  issueIdByKey: Map<string, string>;
  /** The reverse of issueIdByKey, for the page's keys. */
  keyByIssueId: Map<string, string>;
  issueById: Map<string, ReconcileIssueRow>;
  /** Comments per issue key: how many have an external ref and still exist, and their bodies (for inline media). */
  commentsByKey: Map<string, { count: number; bodies: unknown[] }>;
  worklogCountByKey: Map<string, number>;
  /** Attachment external_ref "KEY/attId" -> its row. */
  attachmentBySource: Map<string, { status: string; error: string | null; fileName: string }>;
  /** Kompast issue id -> the issue ids its issue_link rows point at. */
  linkTargetsByIssueId: Map<string, string[]>;
  /** Kompast issue id -> the user ids watching it. */
  watcherUserIdsByIssueId: Map<string, Set<string>>;
  /** "issueId|field" for every field a non-import edit changed since the last sync. */
  editedFields: Set<string>;
}

/** The JIRA keys a page needs Kompast's view of: its own issues, their parents and their outward link targets. */
export function keysNeededBy(issues: JiraIssue[]): string[] {
  const keys = new Set<string>();
  for (const issue of issues) {
    keys.add(issue.key);
    if (issue.fields.parent?.key) keys.add(issue.fields.parent.key);
    for (const l of issue.fields.issuelinks ?? []) if (l.outwardIssue) keys.add(l.outwardIssue.key);
  }
  return [...keys];
}

/**
 * Reads everything a page compares against, in batched queries: issue refs, issue rows, comment and worklog refs
 * (joined to their rows), attachment refs, links, watchers and the non-import history since the last sync.
 */
export async function readReconcileSnapshot(tx: Tx, env: ReconcileEnv, issues: JiraIssue[]): Promise<ReconcileSnapshot> {
  const snap: ReconcileSnapshot = {
    issueIdByKey: new Map(),
    keyByIssueId: new Map(),
    issueById: new Map(),
    commentsByKey: new Map(),
    worklogCountByKey: new Map(),
    attachmentBySource: new Map(),
    linkTargetsByIssueId: new Map(),
    watcherUserIdsByIssueId: new Map(),
    editedFields: new Set(),
  };
  const keys = keysNeededBy(issues);
  const pageKeys = issues.map((i) => i.key);
  if (keys.length === 0) return snap;

  const refs = await tx
    .select({ sourceId: schema.externalRef.sourceId, entityId: schema.externalRef.entityId })
    .from(schema.externalRef)
    .where(
      and(
        eq(schema.externalRef.organizationId, env.organizationId),
        eq(schema.externalRef.source, "jira"),
        eq(schema.externalRef.entityType, "issue"),
        inArray(schema.externalRef.sourceId, keys),
      ),
    );
  for (const r of refs) {
    snap.issueIdByKey.set(r.sourceId, r.entityId);
    snap.keyByIssueId.set(r.entityId, r.sourceId);
  }

  const ids = [...new Set(pageKeys.map((k) => snap.issueIdByKey.get(k)).filter((v): v is string => !!v))];
  if (ids.length === 0) return snap;

  const rows = await tx
    .select({
      id: schema.issue.id,
      keySeq: schema.issue.keySeq,
      title: schema.issue.title,
      statusId: schema.issue.statusId,
      typeId: schema.issue.typeId,
      priority: schema.issue.priority,
      assigneeId: schema.issue.assigneeId,
      parentId: schema.issue.parentId,
      sprintId: schema.issue.sprintId,
      storyPoints: schema.issue.storyPoints,
      estimateSeconds: schema.issue.estimateSeconds,
      startDate: schema.issue.startDate,
      dueDate: schema.issue.dueDate,
      descriptionJson: schema.issue.descriptionJson,
      customFields: schema.issue.customFields,
    })
    .from(schema.issue)
    .where(inArray(schema.issue.id, ids));
  for (const r of rows) snap.issueById.set(r.id, r as ReconcileIssueRow);

  // Comments: an external ref "KEY/commentId" whose comment still exists. The key is the ref's part before the slash.
  const keyList = sql.join(
    pageKeys.map((k) => sql`${k}`),
    sql`, `,
  );
  const commentRows = await tx
    .select({ sourceId: schema.externalRef.sourceId, body: schema.issueComment.bodyJson })
    .from(schema.externalRef)
    .innerJoin(schema.issueComment, eq(schema.issueComment.id, schema.externalRef.entityId))
    .where(
      and(
        eq(schema.externalRef.organizationId, env.organizationId),
        eq(schema.externalRef.source, "jira"),
        eq(schema.externalRef.entityType, "comment"),
        sql`split_part(${schema.externalRef.sourceId}, '/', 1) in (${keyList})`,
      ),
    );
  for (const c of commentRows) {
    const key = c.sourceId.slice(0, c.sourceId.lastIndexOf("/"));
    const entry = snap.commentsByKey.get(key) ?? { count: 0, bodies: [] };
    entry.count++;
    entry.bodies.push(c.body);
    snap.commentsByKey.set(key, entry);
  }

  const worklogRows = await tx
    .select({ sourceId: schema.externalRef.sourceId })
    .from(schema.externalRef)
    .innerJoin(schema.worklog, eq(schema.worklog.id, schema.externalRef.entityId))
    .where(
      and(
        eq(schema.externalRef.organizationId, env.organizationId),
        eq(schema.externalRef.source, "jira"),
        eq(schema.externalRef.entityType, "worklog"),
        sql`split_part(${schema.externalRef.sourceId}, '/', 1) in (${keyList})`,
      ),
    );
  for (const w of worklogRows) {
    const key = w.sourceId.slice(0, w.sourceId.lastIndexOf("/"));
    snap.worklogCountByKey.set(key, (snap.worklogCountByKey.get(key) ?? 0) + 1);
  }

  const attachmentSources = issues.flatMap((i) => (i.fields.attachment ?? []).map((a) => `${i.key}/${a.id}`));
  if (attachmentSources.length > 0) {
    const attRows = await tx
      .select({ sourceId: schema.externalRef.sourceId, status: schema.issueAttachment.status, error: schema.issueAttachment.error, fileName: schema.issueAttachment.fileName })
      .from(schema.externalRef)
      .innerJoin(schema.issueAttachment, eq(schema.issueAttachment.id, schema.externalRef.entityId))
      .where(
        and(
          eq(schema.externalRef.organizationId, env.organizationId),
          eq(schema.externalRef.source, "jira"),
          eq(schema.externalRef.entityType, "attachment"),
          inArray(schema.externalRef.sourceId, attachmentSources),
        ),
      );
    for (const a of attRows) snap.attachmentBySource.set(a.sourceId, { status: a.status, error: a.error, fileName: a.fileName });
  }

  const linkRows = await tx.select({ from: schema.issueLink.fromIssueId, to: schema.issueLink.toIssueId }).from(schema.issueLink).where(inArray(schema.issueLink.fromIssueId, ids));
  for (const l of linkRows) snap.linkTargetsByIssueId.set(l.from, [...(snap.linkTargetsByIssueId.get(l.from) ?? []), l.to]);

  const watcherRows = await tx.select({ issueId: schema.issueWatcher.issueId, userId: schema.issueWatcher.userId }).from(schema.issueWatcher).where(inArray(schema.issueWatcher.issueId, ids));
  for (const w of watcherRows) {
    const set = snap.watcherUserIdsByIssueId.get(w.issueId) ?? new Set<string>();
    set.add(w.userId);
    snap.watcherUserIdsByIssueId.set(w.issueId, set);
  }

  if (env.lastSyncedAt) {
    const edited = await tx
      .select({ issueId: schema.issueHistory.issueId, field: schema.issueHistory.field })
      .from(schema.issueHistory)
      .where(
        and(
          inArray(schema.issueHistory.issueId, ids),
          sql`${schema.issueHistory.origin} <> 'import'`,
          sql`${schema.issueHistory.createdAt} > ${env.lastSyncedAt.toISOString()}::timestamptz`,
        ),
      );
    for (const e of edited) snap.editedFields.add(`${e.issueId}|${e.field}`);
  }

  return snap;
}

/** The imported issues of the project: JIRA key and Kompast issue id, from external_ref. For the missing check. */
export async function readImportedIssueKeys(tx: Tx, env: Pick<ReconcileEnv, "organizationId" | "projectId">): Promise<{ key: string; issueId: string }[]> {
  const rows = await tx
    .select({ key: schema.externalRef.sourceId, issueId: schema.externalRef.entityId })
    .from(schema.externalRef)
    .innerJoin(schema.issue, eq(schema.issue.id, schema.externalRef.entityId))
    .where(
      and(
        eq(schema.externalRef.organizationId, env.organizationId),
        eq(schema.externalRef.source, "jira"),
        eq(schema.externalRef.entityType, "issue"),
        eq(schema.issue.projectId, env.projectId),
      ),
    );
  return rows;
}

// ── Comparison (pure) ───────────────────────────────────────────────────────

function keyNumberOf(jiraKey: string): number | null {
  const match = /-(\d+)$/.exec(jiraKey);
  return match ? Number(match[1]) : null;
}

/** A value for a difference's text form. */
function show(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** JSON with keys sorted, so two equal values compare equal however JSONB ordered them. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v,
  );
}

/** Blocks and ADF nodes: every object under `value`, depth first. */
function forEachNode(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const v of value) forEachNode(v, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  visit(node);
  for (const v of Object.values(node)) forEachNode(v, visit);
}

const PLACEHOLDER_TEXT = "Attachment not found in JIRA";
const JIRA_URL = /atlassian\.net|\/rest\/api\/3\/attachment/;

/** Media in a JIRA body (ADF): each media node is one attachment or external file. */
function jiraMediaCount(body: unknown): number {
  let n = 0;
  forEachNode(body, (node) => {
    if (node.type === "media") n++;
  });
  return n;
}

/** Image and file blocks in a Kompast body, and how many still point at JIRA or are placeholders. */
function kompastMediaOf(body: unknown): { media: number; placeholders: number; jiraUrls: number } {
  const out = { media: 0, placeholders: 0, jiraUrls: 0 };
  forEachNode(body, (node) => {
    if (node.type === "image" || node.type === "file") {
      out.media++;
      const url = (node.props as { url?: unknown } | undefined)?.url;
      if (typeof url === "string" && JIRA_URL.test(url)) out.jiraUrls++;
    }
    if (node.type === "text" && typeof node.text === "string") {
      let at = node.text.indexOf(PLACEHOLDER_TEXT);
      while (at >= 0) {
        out.placeholders++;
        at = node.text.indexOf(PLACEHOLDER_TEXT, at + PLACEHOLDER_TEXT.length);
      }
    }
  });
  return out;
}

/**
 * The Kompast sprint an issue is on now, as the loader and the sync decide it (currentJiraSprintIdOf, over the JIRA
 * sprint order the loader plans with). Returns the Kompast sprint id, or null for the backlog.
 */
export function currentSprintIdOf(issue: JiraIssue, env: Pick<ReconcileEnv, "sprintRefs" | "sprintOrder">): string | null {
  const ranks = new Map<number, SprintRank>();
  for (const [jiraId, ref] of env.sprintRefs) {
    const order = env.sprintOrder.get(jiraId);
    if (order !== undefined) ranks.set(jiraId, { order, open: ref.state !== "closed" });
  }
  const currentId = currentJiraSprintIdOf(issue, ranks);
  return currentId === null ? null : (env.sprintRefs.get(currentId)?.sprintId ?? null);
}

/** The JIRA sprint an issue is on now (its name), by the same rule. Used to show the JIRA side of a difference. */
function currentJiraSprintName(issue: JiraIssue, env: Pick<ReconcileEnv, "sprintRefs" | "sprintOrder">): string | null {
  const id = currentSprintIdOf(issue, env);
  if (!id) return null;
  for (const s of extractJiraSprints(issue)) {
    const ref = env.sprintRefs.get(s.id);
    if (ref?.sprintId === id) return s.name;
  }
  return null;
}

function expectedStatusId(env: ReconcileEnv, jiraName: string): string | undefined {
  const lower = jiraName.toLowerCase();
  const entry = env.mapping.statuses.find((s) => s.jiraName.toLowerCase() === lower);
  if (entry?.action === "map" && entry.kompastStatusId) return entry.kompastStatusId;
  return env.statusIdByName.get(lower);
}

function expectedTypeId(env: ReconcileEnv, jiraName: string): string | undefined {
  const lower = jiraName.toLowerCase();
  const entry = env.mapping.types.find((t) => t.jiraName.toLowerCase() === lower);
  if (entry?.action === "map" && entry.kompastTypeId) return entry.kompastTypeId;
  return env.typeIdByName.get(lower);
}

function expectedUserId(env: ReconcileEnv, user: JiraUser | null | undefined): string | null {
  if (!user) return null;
  return env.mappedUserByAccount.get(user.accountId) ?? env.formerUserByAccount.get(user.accountId) ?? null;
}

/** The JIRA watchers a fetch returned, mapped or not, for one issue. Absent when the call budget was spent. */
export type WatcherLists = Map<string, JiraUser[]>;

/**
 * Compares one page's issues with Kompast. Pure: every read happened in readReconcileSnapshot, and the watcher lists
 * the caller fetched (within its call budget) come in as `watchers`.
 */
export function comparePage(input: { env: ReconcileEnv; snap: ReconcileSnapshot; issues: JiraIssue[]; watchers: WatcherLists; log: ReconcileLog }): void {
  const { env, snap, issues, watchers, log } = input;
  for (const issue of issues) {
    const key = issue.key;
    log.tally("issues", { jira: 1 });
    const issueId = snap.issueIdByKey.get(key);
    const row = issueId ? snap.issueById.get(issueId) : undefined;
    if (!issueId || !row) {
      log.difference({ category: "issues", issueKey: key, jira: key, kompast: null, reason: "unexplained", detail: "in JIRA, not imported into Kompast" });
      continue;
    }
    log.tally("issues", { kompast: 1, matched: 1 });
    compareKeyNumber(env, log, key, row);
    compareValue(log, "title", key, issue.fields.summary, row.title, snap.editedFields.has(`${row.id}|title`), null);
    compareStatus(env, snap, log, issue, row);
    compareType(env, log, issue, row);
    comparePriority(env, log, issue, row);
    compareAssignee(env, snap, log, issue, row);
    compareParent(snap, log, issue, row);
    compareSprint(env, log, issue, row);
    compareCounts(log, "comments", key, issue.fields.comment?.total ?? issue.fields.comment?.comments?.length ?? 0, snap.commentsByKey.get(key)?.count ?? 0);
    compareCounts(log, "worklogs", key, issue.fields.worklog?.total ?? issue.fields.worklog?.worklogs?.length ?? 0, snap.worklogCountByKey.get(key) ?? 0);
    compareAttachments(log, snap, issue);
    compareLinks(snap, log, issue, row);
    compareWatchers(env, snap, log, issue, row, watchers.get(key));
    compareFields(env, snap, log, issue, row);
    compareInlineMedia(snap, log, issue, row);
  }
}

function compareKeyNumber(env: ReconcileEnv, log: ReconcileLog, key: string, row: ReconcileIssueRow): void {
  const jiraNumber = keyNumberOf(key);
  log.tally("keyNumbers", { jira: 1, kompast: 1 });
  if (jiraNumber === row.keySeq) {
    log.tally("keyNumbers", { matched: 1 });
    return;
  }
  log.difference({
    category: "keyNumbers",
    issueKey: key,
    jira: jiraNumber,
    kompast: row.keySeq,
    reason: env.renumbered.has(key) ? "explained:renumbered" : "unexplained",
    detail: `${env.projectKey}-${row.keySeq}`,
  });
}

/**
 * A plain value check: both sides count as a unit, and a difference is explained when Kompast edited the field after the
 * last sync (`editField`), or when the caller names a cause.
 */
function compareValue(log: ReconcileLog, category: ReconcileCategory, key: string, jira: unknown, kompast: unknown, edited: boolean, cause: string | null, detail?: string): void {
  log.tally(category, { jira: 1, kompast: 1 });
  if (stable(jira ?? null) === stable(kompast ?? null)) {
    log.tally(category, { matched: 1 });
    return;
  }
  const reason: ReconcileDifference["reason"] = edited ? "explained:edited-in-kompast" : cause ? `explained:${cause}` : "unexplained";
  log.difference({ category, issueKey: key, jira: show(jira), kompast: show(kompast), reason, ...(detail ? { detail } : {}) });
}

function compareStatus(env: ReconcileEnv, snap: ReconcileSnapshot, log: ReconcileLog, issue: JiraIssue, row: ReconcileIssueRow): void {
  const jiraName = issue.fields.status.name;
  const expected = expectedStatusId(env, jiraName);
  const edited = snap.editedFields.has(`${row.id}|status`);
  const kompastName = env.statusNameById.get(row.statusId) ?? row.statusId;
  if (expected === undefined) {
    log.tally("status", { jira: 1, kompast: 1 });
    log.difference({ category: "status", issueKey: issue.key, jira: jiraName, kompast: kompastName, reason: "unexplained", detail: "the JIRA status has no Kompast status" });
    return;
  }
  log.tally("status", { jira: 1, kompast: 1 });
  if (expected === row.statusId) {
    log.tally("status", { matched: 1 });
    return;
  }
  log.difference({ category: "status", issueKey: issue.key, jira: jiraName, kompast: kompastName, reason: edited ? "explained:edited-in-kompast" : "unexplained" });
}

function compareType(env: ReconcileEnv, log: ReconcileLog, issue: JiraIssue, row: ReconcileIssueRow): void {
  const jiraName = issue.fields.issuetype.name;
  const expected = expectedTypeId(env, jiraName);
  const kompastName = env.typeNameById.get(row.typeId) ?? row.typeId;
  log.tally("type", { jira: 1, kompast: 1 });
  if (expected === row.typeId) {
    log.tally("type", { matched: 1 });
    return;
  }
  log.difference({ category: "type", issueKey: issue.key, jira: jiraName, kompast: kompastName, reason: "unexplained" });
}

function comparePriority(env: ReconcileEnv, log: ReconcileLog, issue: JiraIssue, row: ReconcileIssueRow): void {
  const expected = resolvePriorityKey(issue.fields.priority?.name, env.priorityLevels, env.mapping.priorities ?? []);
  log.tally("priority", { jira: 1, kompast: 1 });
  if (expected === row.priority) {
    log.tally("priority", { matched: 1 });
    return;
  }
  log.difference({ category: "priority", issueKey: issue.key, jira: issue.fields.priority?.name ?? null, kompast: row.priority, reason: "unexplained" });
}

function compareAssignee(env: ReconcileEnv, snap: ReconcileSnapshot, log: ReconcileLog, issue: JiraIssue, row: ReconcileIssueRow): void {
  const expected = expectedUserId(env, issue.fields.assignee);
  const jiraName = issue.fields.assignee?.displayName ?? null;
  if (expected === null && row.assigneeId === null) return;
  log.tally("assignee", { jira: 1, kompast: 1 });
  if (expected === row.assigneeId) {
    log.tally("assignee", { matched: 1 });
    return;
  }
  const edited = snap.editedFields.has(`${row.id}|assigneeId`);
  log.difference({ category: "assignee", issueKey: issue.key, jira: jiraName, kompast: row.assigneeId, reason: edited ? "explained:edited-in-kompast" : "unexplained" });
}

function compareParent(snap: ReconcileSnapshot, log: ReconcileLog, issue: JiraIssue, row: ReconcileIssueRow): void {
  const jiraParent = issue.fields.parent?.key ?? null;
  if (!jiraParent && !row.parentId) return;
  log.tally("parent", { jira: jiraParent ? 1 : 0, kompast: row.parentId ? 1 : 0 });
  const kompastParentKey = row.parentId ? (snap.keyByIssueId.get(row.parentId) ?? row.parentId) : null;
  if (jiraParent && kompastParentKey === jiraParent) {
    log.tally("parent", { matched: 1 });
    return;
  }
  if (jiraParent && !snap.issueIdByKey.has(jiraParent) && !row.parentId) {
    log.difference({ category: "parent", issueKey: issue.key, jira: jiraParent, kompast: null, reason: "explained:parent-not-imported" });
    return;
  }
  log.difference({ category: "parent", issueKey: issue.key, jira: jiraParent, kompast: kompastParentKey, reason: "unexplained" });
}

function compareSprint(env: ReconcileEnv, log: ReconcileLog, issue: JiraIssue, row: ReconcileIssueRow): void {
  const expected = currentSprintIdOf(issue, env);
  if (!expected && !row.sprintId) return;
  log.tally("sprint", { jira: 1, kompast: 1 });
  if (expected === row.sprintId) {
    log.tally("sprint", { matched: 1 });
    return;
  }
  const kompastName = row.sprintId ? ([...env.sprintRefs.values()].find((s) => s.sprintId === row.sprintId)?.name ?? row.sprintId) : null;
  log.difference({ category: "sprint", issueKey: issue.key, jira: currentJiraSprintName(issue, env), kompast: kompastName, reason: "unexplained" });
}

function compareCounts(log: ReconcileLog, category: "comments" | "worklogs", key: string, jiraCount: number, kompastCount: number): void {
  log.tally(category, { jira: jiraCount, kompast: kompastCount, matched: Math.min(jiraCount, kompastCount) });
  if (jiraCount !== kompastCount) log.difference({ category, issueKey: key, jira: jiraCount, kompast: kompastCount, reason: "unexplained" });
}

function compareAttachments(log: ReconcileLog, snap: ReconcileSnapshot, issue: JiraIssue): void {
  for (const att of issue.fields.attachment ?? []) {
    log.tally("attachments", { jira: 1 });
    const row = snap.attachmentBySource.get(`${issue.key}/${att.id}`);
    if (!row) {
      log.difference({ category: "attachments", issueKey: issue.key, jira: att.filename, kompast: null, reason: "unexplained", detail: "no copy or placeholder for this file" });
      continue;
    }
    log.tally("attachments", { kompast: 1 });
    if (row.status === "stored") {
      log.tally("attachments", { matched: 1 });
    } else if (row.status === "not_migrated") {
      log.difference({ category: "attachments", issueKey: issue.key, jira: att.filename, kompast: "not_migrated", reason: "explained:not-migrated", detail: `${att.size} bytes is over the size limit` });
    } else if (row.status === "failed") {
      log.difference({ category: "attachments", issueKey: issue.key, jira: att.filename, kompast: "failed", reason: "explained:copy-failed", ...(row.error ? { detail: row.error } : {}) });
    } else {
      log.difference({ category: "attachments", issueKey: issue.key, jira: att.filename, kompast: row.status, reason: "unexplained", detail: "still waiting to be copied" });
    }
  }
}

function compareLinks(snap: ReconcileSnapshot, log: ReconcileLog, issue: JiraIssue, row: ReconcileIssueRow): void {
  let imported = 0;
  for (const link of issue.fields.issuelinks ?? []) {
    if (!link.outwardIssue) continue;
    if (snap.issueIdByKey.has(link.outwardIssue.key)) {
      imported++;
    } else {
      log.difference({ category: "links", issueKey: issue.key, jira: link.outwardIssue.key, kompast: null, reason: "explained:outside-project", detail: link.type.name });
    }
  }
  const kompastLinks = snap.linkTargetsByIssueId.get(row.id)?.length ?? 0;
  if (imported === 0 && kompastLinks === 0) return;
  log.tally("links", { jira: imported, kompast: kompastLinks, matched: Math.min(imported, kompastLinks) });
  if (imported !== kompastLinks) log.difference({ category: "links", issueKey: issue.key, jira: imported, kompast: kompastLinks, reason: "unexplained" });
}

/**
 * Watchers. Kompast has at least as many as JIRA: nothing to check. Fewer: the watcher list is fetched (within budget)
 * and each mapped person must be watching; former members and unmapped people are the explained, expected gap. With no
 * list (budget spent), a gap no bigger than the former/unmapped people is explained as unverified, else unexplained.
 */
function compareWatchers(env: ReconcileEnv, snap: ReconcileSnapshot, log: ReconcileLog, issue: JiraIssue, row: ReconcileIssueRow, list: JiraUser[] | undefined): void {
  const jiraCount = issue.fields.watches?.watchCount ?? 0;
  const kompastSet = snap.watcherUserIdsByIssueId.get(row.id) ?? new Set<string>();
  const kompastCount = kompastSet.size;
  if (jiraCount === 0 && kompastCount === 0) return;
  if (kompastCount >= jiraCount) {
    log.tally("watchers", { jira: jiraCount, kompast: kompastCount, matched: jiraCount });
    return;
  }
  if (list) {
    const mapped = list.map((u) => env.mappedUserByAccount.get(u.accountId)).filter((v): v is string => !!v);
    const present = mapped.filter((id) => kompastSet.has(id)).length;
    const unmapped = list.length - mapped.length;
    log.tally("watchers", { jira: jiraCount, kompast: kompastCount, matched: present });
    for (const id of mapped) {
      if (!kompastSet.has(id)) log.difference({ category: "watchers", issueKey: issue.key, jira: id, kompast: null, reason: "unexplained", detail: "mapped watcher not watching in Kompast" });
    }
    if (unmapped > 0) {
      log.difference({ category: "watchers", issueKey: issue.key, jira: unmapped, kompast: null, reason: "explained:unmapped-watchers", detail: "former members or people not in this project" });
    }
    return;
  }
  const gap = jiraCount - kompastCount;
  const expectedGap = env.mapping.people.filter((p) => p.action !== "map").length;
  log.tally("watchers", { jira: jiraCount, kompast: kompastCount, matched: kompastCount });
  log.difference({
    category: "watchers",
    issueKey: issue.key,
    jira: jiraCount,
    kompast: kompastCount,
    reason: gap <= expectedGap ? "explained:watchers-unverified" : "unexplained",
    detail: "watcher list not fetched (call budget spent)",
  });
}

function compareFields(env: ReconcileEnv, snap: ReconcileSnapshot, log: ReconcileLog, issue: JiraIssue, row: ReconcileIssueRow): void {
  if (!env.fieldTargets) return;
  const resolve = (user: JiraUser | null | undefined) => expectedUserId(env, user);
  for (const target of env.fieldTargets) {
    const raw = (issue.fields as unknown as Record<string, unknown>)[target.jiraFieldId];
    const result: JiraValueConversion = convertJiraValue(raw, target.type, { transform: target.transform, resolveUser: (u) => resolve(u) });
    const field = target.kind === "core" ? target.coreField! : `customFields.${target.propertyKey}`;
    const edited = snap.editedFields.has(`${row.id}|${field}`);
    const kompast = kompastValueOf(row, target);
    if (result.kind === "empty" || result.kind === "unresolved") {
      if (kompast === null) continue;
      log.tally("fields", { jira: 0, kompast: 1 });
      log.difference({ category: "fields", issueKey: issue.key, jira: null, kompast: show(kompast), reason: edited ? "explained:edited-in-kompast" : "unexplained", detail: target.jiraName });
      continue;
    }
    if (result.kind === "error") {
      log.tally("fields", { jira: 1, kompast: kompast === null ? 0 : 1 });
      log.difference({ category: "fields", issueKey: issue.key, jira: target.jiraName, kompast: show(kompast), reason: "explained:value-not-converted", detail: result.message });
      continue;
    }
    const expected = expectedFieldValue(target, result);
    log.tally("fields", { jira: 1, kompast: kompast === null ? 0 : 1 });
    if (stable(expected ?? null) === stable(kompast ?? null)) {
      log.tally("fields", { matched: 1 });
      continue;
    }
    log.difference({ category: "fields", issueKey: issue.key, jira: show(expected), kompast: show(kompast), reason: edited ? "explained:edited-in-kompast" : "unexplained", detail: target.jiraName });
  }
}

/** The stored value of a field target, as the comparison reads it: a core column, or a custom property's value. */
function kompastValueOf(row: ReconcileIssueRow, target: PreparedFieldTarget): unknown {
  if (target.kind === "core") {
    switch (target.coreField) {
      case "storyPoints":
        return row.storyPoints;
      case "estimateSeconds":
        return row.estimateSeconds;
      case "startDate":
        return row.startDate?.toISOString() ?? null;
      case "dueDate":
        return row.dueDate?.toISOString() ?? null;
      default:
        return null;
    }
  }
  const custom = (row.customFields as Record<string, unknown>)[target.propertyKey!];
  return custom === undefined ? null : custom;
}

/** The value a loader would store for a converted field, in the same shape kompastValueOf returns. */
function expectedFieldValue(target: PreparedFieldTarget, result: { kind: "value"; value: string | number | boolean | string[] }): unknown {
  if (target.kind === "core") {
    if (target.coreField === "storyPoints" && typeof result.value === "number") return Math.round(result.value);
    if (target.coreField === "estimateSeconds" && typeof result.value === "number") return Math.round(result.value);
    if ((target.coreField === "dueDate" || target.coreField === "startDate") && typeof result.value === "string") {
      const d = new Date(result.value);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    return null;
  }
  return result.value;
}

function compareInlineMedia(snap: ReconcileSnapshot, log: ReconcileLog, issue: JiraIssue, row: ReconcileIssueRow): void {
  const comments = snap.commentsByKey.get(issue.key)?.bodies ?? [];
  const jiraMedia = jiraMediaCount(issue.fields.description) + (issue.fields.comment?.comments ?? []).reduce((n, c) => n + jiraMediaCount(c.body), 0);
  const kompastBodies = [row.descriptionJson, ...comments];
  let kompastMedia = 0;
  let placeholders = 0;
  let jiraUrls = 0;
  for (const body of kompastBodies) {
    const m = kompastMediaOf(body);
    kompastMedia += m.media;
    placeholders += m.placeholders;
    jiraUrls += m.jiraUrls;
  }
  if (jiraMedia === 0 && kompastMedia === 0) return;
  log.tally("inlineMedia", { jira: jiraMedia, kompast: kompastMedia, matched: Math.max(0, kompastMedia - placeholders - jiraUrls) });
  if (placeholders > 0) {
    log.difference({ category: "inlineMedia", issueKey: issue.key, jira: null, kompast: placeholders, reason: "explained:unmatched-media", detail: "no attachment in the JIRA data matched this file" });
  }
  if (jiraUrls > 0) {
    log.difference({ category: "inlineMedia", issueKey: issue.key, jira: null, kompast: jiraUrls, reason: "unexplained", detail: "still points at a JIRA URL" });
  }
}

/** Sprints: every JIRA board sprint against the imported sprint of the same JIRA id. State and name must match. */
export function compareSprints(env: ReconcileEnv, jiraSprints: JiraSprint[], log: ReconcileLog): void {
  const activeCount = jiraSprints.filter((s) => s.state === "active").length;
  for (const s of jiraSprints) {
    log.tally("sprints", { jira: 1 });
    const ref = env.sprintRefs.get(s.id);
    if (!ref) {
      log.difference({ category: "sprints", issueKey: `sprint:${s.id}`, jira: s.name, kompast: null, reason: "unexplained", detail: "JIRA sprint not imported" });
      continue;
    }
    log.tally("sprints", { kompast: 1 });
    const stateSame = ref.state === s.state;
    if (stateSame && ref.name === s.name) {
      log.tally("sprints", { matched: 1 });
      continue;
    }
    // Parallel active sprints: Kompast allows one active sprint per board, so the second one is imported as future.
    const parallel = s.state === "active" && ref.state === "future" && activeCount > 1 && ref.name === s.name;
    log.difference({
      category: "sprints",
      issueKey: `sprint:${s.id}`,
      jira: `${s.name} (${s.state})`,
      kompast: `${ref.name} (${ref.state})`,
      reason: parallel ? "explained:parallel-active" : "unexplained",
    });
  }
}

/** Imported keys JIRA's listing did not show: each is checked one GET at a time by the runner (404 deleted, another key moved). */
export function missingKeysOf(imported: { key: string }[], seen: Set<string>): string[] {
  return imported.map((r) => r.key).filter((k) => !seen.has(k));
}
