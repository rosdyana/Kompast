import { and, eq, schema, sql, type Json } from "@kompast/db";
import {
  createIssue,
  updateIssue,
  addComment,
  enqueueReindex,
  logWork,
  linkIssues,
  attachIssueFile,
  recordImportedAttachmentPlaceholder,
  recordHistoricalStatusChange,
  recordHistoricalFieldChange,
  setWatching,
  ensureImportedFormerUser,
  resolveExternalRef,
  upsertExternalRef,
  createWorkflowStatus,
  createIssueType,
  getActiveSprint,
  listSprintNumbers,
  importSprint,
  importIssueSprintMemberships,
  recordImportedSprintSnapshot,
  type ImportedSprintMembership,
  listPriorityLevels,
  listIssuePropertyDefinitions,
  createIssuePropertyDefinition,
  type IssuePropertyType,
  type JiraCoreField,
  type JiraFieldMapping,
  type JiraStatusColumnPlacement,
  type Tx,
  type UpdateIssueInput,
  moveImportedIssueSprint,
  listWatchers,
  completeImportedSprint,
  activateImportedSprint,
  updateImportedSprint,
} from "@kompast/core";
import { adfToPlainText } from "./adf";
import { adfToBlocks, type BlockNode } from "./adf-to-blocks";
import type { JiraDiscovery } from "./discover";
import {
  classifyJiraField,
  convertJiraValue,
  isHandledJiraField,
  JIRA_CORE_FIELD_TYPE,
  sampleText,
  SECONDS_TO_HOURS,
  type JiraFieldReason,
} from "./fields";
import { extractJiraSprints, mapJiraStatusCategory, parseJiraSprintNumber, resolvePriorityKey, type PriorityLevelRef } from "./map";
import type { JiraMigrationMapping } from "./mapping";
import { currentJiraSprintIdOf, orderJiraSprints, type SprintRank } from "./sprint-order";
import { collectInlineAttachmentIds, INLINE_ATTACHMENT_HARD_CAP_BYTES, linkUnavailableAttachment, rewriteAttachmentUrls, rewriteIssueInlineAttachments } from "./inline-attachments";
import type { JiraAttachment, JiraChangelogItem, JiraIssue, JiraSprint, JiraStatusCategoryKey, JiraUser } from "./types";

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
  /**
   * Set when the load runs from a migration (its mapping is present). Each JIRA attachment on a new issue gets a
   * placeholder row instead: pending (its bytes are copied later, by the attachments phase) or not_migrated. Takes
   * precedence over downloadAttachment. maxBytes is the mapping's limit (null = no limit).
   */
  migrationAttachments?: { maxBytes: number | null };
  /**
   * The JIRA project's key ("ZTRD"): recognises links to the migrated project's
   * issues, so they become issue mentions. Derived from the issues when omitted.
   */
  jiraProjectKey?: string;
  /** JIRA's story-points custom field id, from discovery. Its changes are written to issue history as storyPoints. */
  storyPointsFieldId?: string;
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
    /** Migration placeholders written as pending: their bytes are copied by the attachments phase. */
    attachmentsQueued: number;
    /** Migration placeholders written as not_migrated: over the size limit (and not inline), so never copied. */
    attachmentsNotMigrated: number;
    /** Attachments referenced inline that are over the size limit. They are copied only up to the inline hard cap. */
    inlineAttachmentsOverLimit: number;
    parentLinksResolved: number;
    historicalTransitionsRecorded: number;
    sprintsCreated: number;
    sprintMembershipsCreated: number;
    issuesInBacklog: number;
    /** JIRA issues whose number was already used in the project, so they got the next free number. */
    issuesRenumbered: number;
    /** Former JIRA members given a placeholder user (no sign-in, no membership). */
    formerMembersCreated: number;
    /** Changelog entries recorded as issue history, other than status (those are historicalTransitionsRecorded). */
    historyEntriesRecorded: number;
    watchersAdded: number;
    watchersSkipped: number;
    issueMentionsResolved: number;
    issueMentionsUnresolved: number;
    /** Requests made by enrich.ts to fill in comments, changelog, worklogs and watchers the search response only partly embeds. */
    commentPagesFetched: number;
    changelogPagesFetched: number;
    worklogPagesFetched: number;
    watcherCalls: number;
    /** Requests for a description's rendered HTML, to find the attachment ids of its inline media (enrich.ts). */
    renderedDescriptionCalls: number;
    /** Comment pages fetched only for their rendered HTML (inline media ids). */
    renderedCommentCalls: number;
    /** Inline file media given an attachment id from the rendered HTML, by position. */
    mediaMatchedByPosition: number;
    /** Inline file media whose rendered position couldn't be trusted, so it stayed unmatched (enrich.ts). */
    mediaPositionMismatch: number;
    /** Inline media (file or external) that linked to an attachment or URL. */
    inlineMediaLinked: number;
    /** Inline media that matched no attachment. Each is written as an "Attachment not found in JIRA" note. */
    inlineMediaUnmatched: number;
    /** ADF node types the converter doesn't know. Their text is kept as a paragraph. Summed across all types. */
    unknownAdfNodes: number;
    /** Custom properties created by the field mapping (a re-run reuses them, so it creates none). */
    propertiesCreated: number;
    /** Field values written: core fields and custom properties, per issue created in this run. */
    fieldValuesWritten: number;
    /** Field values left out: a value that didn't convert (its error is in `errors`), or a person with no Kompast user. */
    fieldValuesSkipped: number;
    /** Select and multi-select values the property didn't list yet, appended to its options. */
    propertyOptionsAdded: number;
    /** Story points JIRA gave with a decimal, rounded into the whole-number column. */
    storyPointsRounded: number;
  };
  /**
   * What happens to each JIRA sprint, in order (closed by date, then
   * active, then future). `number` is the Kompast sprint number: the one in
   * the JIRA name when it's free on this board, otherwise the next free one.
   * `existing-active`: the board already had an active sprint, so JIRA's
   * active sprint's issues go into it. `already-imported`: an earlier run
   * created it.
   */
  sprintMapping: {
    jiraSprintId: number;
    jiraSprintName: string;
    state: "closed" | "active" | "future";
    number: number;
    action: "create" | "existing-active" | "already-imported";
    kompastSprintId: string | null;
  }[];
  statusMapping: { jiraStatusName: string; category: "todo" | "in_progress" | "done"; matchedExistingStatusId: string | null }[];
  typeMapping: { jiraTypeName: string; matchedExistingTypeId: string | null }[];
  errors: { issueKey: string; error: string }[];
  /** Informational, not failures (e.g. a renumbered issue). Kept apart from errors. */
  notes: { issueKey: string; note: string }[];
}

type LinkType = "blocks" | "relates" | "duplicates" | "clones";

export interface DeferredParent {
  childKey: string;
  parentKey: string;
  /** The child's JIRA updated time, restored after the parent link is written (see finalizeJiraImport). */
  updatedAt?: string;
  /** The child's JIRA created time. The parent link's history row is backdated to it (the link existed since then). */
  createdAt?: string;
  /** The child's resolved reporter (the importer when unresolved). The parent link's history row is attributed to them. */
  historyActorId?: string;
}

export interface DeferredLink {
  fromKey: string;
  toKey: string;
  type: LinkType;
}

/** The sprints, statuses and types a load needs, as the caller knows them up front. Discovery supplies them for a migration; runJiraImport derives them from the issues. */
export interface JiraImportInput {
  /** Unique by name, in first-seen order. `categoryKey` is JIRA's statusCategory.key. */
  statuses: { name: string; categoryKey: string }[];
  types: { name: string }[];
  sprints: JiraSprint[];
  /** When given, its "map" actions point statuses/types at existing Kompast rows and its "create" category wins. */
  mapping?: JiraMigrationMapping;
  /** The discovery's option values per field: the options a select or multi-select property is created with. */
  fieldOptions?: JiraDiscovery["fieldOptions"];
}

/**
 * One field the run writes: a core field, or a custom property (existing or
 * created) with the Kompast type its values convert to. `transform` only
 * appears on a number property.
 */
export interface PreparedFieldTarget {
  jiraFieldId: string;
  jiraName: string;
  kind: "core" | "property";
  coreField?: JiraCoreField;
  propertyKey?: string;
  type: IssuePropertyType;
  transform?: "secondsToHours";
}

/** A sprint as stored in the cursor: plain JSON, with dates as ISO strings. */
export interface PreparedSprint {
  jiraSprintId: number;
  jiraName: string;
  state: "closed" | "active" | "future";
  number: number;
  action: "create" | "existing-active" | "already-imported";
  kompastSprintId: string | null;
  startAt: string | null;
  endAt: string | null;
  /** Position in the sprint plan (sprint order). */
  order: number;
}

/**
 * Everything prepareJiraImport decided and created, as plain JSON. A batched
 * run stores this in the migration cursor and hands it back to every
 * loadJiraIssueBatch call. The id maps are keyed by lowercased name.
 */
export interface PreparedJiraImport {
  statusIdByName: Record<string, string>;
  typeIdByName: Record<string, string>;
  /** The project's priority levels when the load was prepared. Every batch resolves issue priorities from these, so all batches agree. Missing on a cursor from before this field: the batch reads the levels itself. */
  priorityLevels?: PriorityLevelRef[];
  /** The mapping's JIRA-priority choices when the load was prepared. Missing or empty: every priority takes the suggestion. */
  priorityMapping?: { jiraName: string; kompastKey: string }[];
  statusMapping: JiraLoadReport["statusMapping"];
  typeMapping: JiraLoadReport["typeMapping"];
  sprintMapping: JiraLoadReport["sprintMapping"];
  sprints: PreparedSprint[];
  /** The placeholder user for each person the mapping marks "former", keyed by JIRA accountId. Missing on a cursor from before this field. */
  formerUserIdByAccount?: Record<string, string>;
  /** The fields the mapping writes, resolved to properties and core targets at prepare time. Absent when the mapping has no fields list (an older mapping): the loader then writes story points by its 3a rule and no other field values. */
  fieldTargets?: PreparedFieldTarget[];
  counts: { statusesCreated: number; typesCreated: number; sprintsCreated: number; formerMembersCreated?: number; propertiesCreated?: number };
}

export interface JiraBatchResult {
  counts: JiraLoadReport["counts"];
  errors: JiraLoadReport["errors"];
  notes: JiraLoadReport["notes"];
  deferredParents: DeferredParent[];
  deferredLinks: DeferredLink[];
}

export interface JiraFinalizeResult {
  counts: Pick<JiraLoadReport["counts"], "parentLinksResolved" | "linksCreated" | "issueMentionsResolved" | "issueMentionsUnresolved">;
  errors: JiraLoadReport["errors"];
}

export function emptyCounts(): JiraLoadReport["counts"] {
  return {
    issuesCreated: 0,
    issuesSkipped: 0,
    statusesCreated: 0,
    typesCreated: 0,
    commentsCreated: 0,
    worklogsCreated: 0,
    linksCreated: 0,
    attachmentsCreated: 0,
    attachmentsSkipped: 0,
    attachmentsQueued: 0,
    attachmentsNotMigrated: 0,
    inlineAttachmentsOverLimit: 0,
    parentLinksResolved: 0,
    historicalTransitionsRecorded: 0,
    sprintsCreated: 0,
    sprintMembershipsCreated: 0,
    issuesInBacklog: 0,
    issuesRenumbered: 0,
    formerMembersCreated: 0,
    historyEntriesRecorded: 0,
    watchersAdded: 0,
    watchersSkipped: 0,
    issueMentionsResolved: 0,
    issueMentionsUnresolved: 0,
    commentPagesFetched: 0,
    changelogPagesFetched: 0,
    worklogPagesFetched: 0,
    watcherCalls: 0,
    renderedDescriptionCalls: 0,
    renderedCommentCalls: 0,
    mediaMatchedByPosition: 0,
    mediaPositionMismatch: 0,
    inlineMediaLinked: 0,
    inlineMediaUnmatched: 0,
    unknownAdfNodes: 0,
    propertiesCreated: 0,
    fieldValuesWritten: 0,
    fieldValuesSkipped: 0,
    propertyOptionsAdded: 0,
    storyPointsRounded: 0,
  };
}

function emptyReport(): JiraLoadReport {
  return { counts: emptyCounts(), sprintMapping: [], statusMapping: [], typeMapping: [], errors: [], notes: [] };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reads a name-keyed id record without falling for inherited keys like "constructor". */
function idOf(record: Record<string, string>, lowerName: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(record, lowerName) ? record[lowerName] : undefined;
}

/**
 * Derives the import input from a batch of already-fetched issues. Statuses
 * and types are unique by name in first-seen order; sprints are deduped by id,
 * last one wins.
 */
export function jiraImportInputFromIssues(issues: JiraIssue[]): JiraImportInput {
  const statuses = new Map<string, { name: string; categoryKey: string }>();
  const types = new Map<string, { name: string }>();
  const sprints = new Map<number, JiraSprint>();
  for (const issue of issues) {
    const typeName = issue.fields.issuetype.name;
    if (!types.has(typeName.toLowerCase())) types.set(typeName.toLowerCase(), { name: typeName });
    const statusName = issue.fields.status.name;
    if (!statuses.has(statusName.toLowerCase())) statuses.set(statusName.toLowerCase(), { name: statusName, categoryKey: issue.fields.status.statusCategory.key });
    for (const s of extractJiraSprints(issue)) sprints.set(s.id, s);
  }
  return { statuses: [...statuses.values()], types: [...types.values()], sprints: [...sprints.values()] };
}

/**
 * A resolver for loadJiraIssueBatch's resolveUserId, built from the confirmed mapping:
 * a "map" entry resolves to its Kompast member, and a "former" entry to its placeholder
 * user (formerUserIdByAccount, from prepareJiraImport). Anyone else resolves to null.
 */
export function resolveUserFromMapping(
  mapping: JiraMigrationMapping,
  formerUserIdByAccount: Record<string, string> = {},
): (jiraUser: JiraUser | null) => string | null {
  const byAccount = new Map<string, string>();
  for (const p of mapping.people) {
    if (p.action === "map" && p.kompastUserId) byAccount.set(p.accountId, p.kompastUserId);
  }
  return (jiraUser) => {
    if (!jiraUser) return null;
    return byAccount.get(jiraUser.accountId) ?? (Object.prototype.hasOwnProperty.call(formerUserIdByAccount, jiraUser.accountId) ? formerUserIdByAccount[jiraUser.accountId]! : null);
  };
}

/** The JIRA project key of a batch of issues, from the first one. The one-shot path has no other source for it. */
export function jiraProjectKeyFromIssues(issues: JiraIssue[]): string | undefined {
  const match = /^(.+)-\d+$/.exec(issues[0]?.key ?? "");
  return match?.[1];
}

/**
 * Runs a full load in one go: prepare → one batch of issues → finalize.
 * Dry-run stops after the plan, so it writes nothing — only read queries
 * against the target project's existing statuses/types/sprints. A real
 * run applies exactly what the dry run showed. Existing callers
 * (apps/web's synchronous import) are unaffected by the batched split.
 */
export async function runJiraImport(tx: Tx, issues: JiraIssue[], ctx: JiraLoadContext): Promise<JiraLoadReport> {
  const input = jiraImportInputFromIssues(issues);
  // The one-shot path has no migration row, so the JIRA project key comes from the issues. Its mapping is
  // absent too: no former-member placeholders, no per-run priority/status choices, and no watcher lists.
  const loadCtx: JiraLoadContext = { ...ctx, jiraProjectKey: ctx.jiraProjectKey ?? jiraProjectKeyFromIssues(issues) };

  if (loadCtx.dryRun) {
    const plan = await planJiraImport(tx, loadCtx, input);
    return { ...emptyReport(), statusMapping: plan.statusMapping, typeMapping: plan.typeMapping, sprintMapping: plan.sprints.map(toSprintMapping) };
  }

  const prepared = await prepareJiraImport(tx, loadCtx, input);
  const batch = await loadJiraIssueBatch(tx, issues, loadCtx, prepared);
  const fin = await finalizeJiraImport(tx, loadCtx, prepared, { deferredParents: batch.deferredParents, deferredLinks: batch.deferredLinks });

  return {
    counts: {
      ...batch.counts,
      statusesCreated: prepared.counts.statusesCreated,
      typesCreated: prepared.counts.typesCreated,
      sprintsCreated: prepared.counts.sprintsCreated,
      formerMembersCreated: prepared.counts.formerMembersCreated ?? 0,
      propertiesCreated: prepared.counts.propertiesCreated ?? 0,
      parentLinksResolved: batch.counts.parentLinksResolved + fin.counts.parentLinksResolved,
      linksCreated: batch.counts.linksCreated + fin.counts.linksCreated,
      issueMentionsResolved: batch.counts.issueMentionsResolved + fin.counts.issueMentionsResolved,
      issueMentionsUnresolved: batch.counts.issueMentionsUnresolved + fin.counts.issueMentionsUnresolved,
    },
    sprintMapping: prepared.sprintMapping,
    statusMapping: prepared.statusMapping,
    typeMapping: prepared.typeMapping,
    errors: [...batch.errors, ...fin.errors],
    notes: batch.notes,
  };
}

// ── Plan (read-only) ────────────────────────────────────────────────────────

interface PlannedSprint {
  jira: JiraSprint;
  /** The Kompast state. Normally JIRA's; a second active JIRA sprint (parallel sprints) is imported as future, since Kompast allows one active sprint per board. */
  state: "closed" | "active" | "future";
  number: number;
  action: "create" | "existing-active" | "already-imported";
  kompastSprintId: string | null;
  startAt?: Date;
  endAt?: Date;
  createdAt: Date;
}

interface JiraImportPlan {
  priorityLevels: PriorityLevelRef[];
  statusIdByName: Map<string, string>;
  typeIdByName: Map<string, string>;
  statusMapping: JiraLoadReport["statusMapping"];
  typeMapping: JiraLoadReport["typeMapping"];
  statusesToCreate: { name: string; category: "todo" | "in_progress" | "done"; column?: JiraStatusColumnPlacement }[];
  typesToCreate: { name: string }[];
  sprints: PlannedSprint[];
}

/** What a plan needs to know about the target: the project and the board its sprints go on. */
type PlanTarget = Pick<JiraLoadContext, "organizationId" | "projectId" | "boardId">;

/**
 * Decides, without writing anything, what each status, type and sprint
 * becomes. Used by a dry run, the read-only preview, and as the first half of
 * prepareJiraImport.
 */
async function planJiraImport(tx: Tx, ctx: PlanTarget, input: JiraImportInput): Promise<JiraImportPlan> {
  const existingTypes = await tx.select().from(schema.issueType).where(eq(schema.issueType.projectId, ctx.projectId));
  const existingStatuses = await tx.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, ctx.projectId));

  const typeIdByName = new Map(existingTypes.map((t) => [t.name.toLowerCase(), t.id]));
  const statusIdByName = new Map(existingStatuses.map((s) => [s.name.toLowerCase(), s.id]));
  const existingTypeIds = new Set(existingTypes.map((t) => t.id));
  const existingStatusIds = new Set(existingStatuses.map((s) => s.id));

  const typeMapping: JiraLoadReport["typeMapping"] = [];
  const typesToCreate: { name: string }[] = [];
  const seenTypes = new Set<string>();
  for (const t of input.types) {
    const key = t.name.toLowerCase();
    if (seenTypes.has(key)) continue;
    seenTypes.add(key);
    const entry = input.mapping?.types.find((m) => m.jiraName.toLowerCase() === key);
    let matched = typeIdByName.get(key) ?? null;
    if (entry?.action === "map" && entry.kompastTypeId && existingTypeIds.has(entry.kompastTypeId)) matched = entry.kompastTypeId;
    typeMapping.push({ jiraTypeName: t.name, matchedExistingTypeId: matched });
    if (matched) typeIdByName.set(key, matched);
    else typesToCreate.push({ name: t.name });
  }

  const statusMapping: JiraLoadReport["statusMapping"] = [];
  const statusesToCreate: JiraImportPlan["statusesToCreate"] = [];
  const seenStatuses = new Set<string>();
  for (const s of input.statuses) {
    const key = s.name.toLowerCase();
    if (seenStatuses.has(key)) continue;
    seenStatuses.add(key);
    const entry = input.mapping?.statuses.find((m) => m.jiraName.toLowerCase() === key);
    const jiraCategory = mapJiraStatusCategory(s.categoryKey as JiraStatusCategoryKey);
    let matched = statusIdByName.get(key) ?? null;
    if (entry?.action === "map" && entry.kompastStatusId && existingStatusIds.has(entry.kompastStatusId)) matched = entry.kompastStatusId;
    statusMapping.push({ jiraStatusName: s.name, category: jiraCategory, matchedExistingStatusId: matched });
    if (matched) statusIdByName.set(key, matched);
    else statusesToCreate.push({ name: s.name, category: entry?.category ?? jiraCategory, column: entry?.action === "create" ? entry.column : undefined });
  }

  const sprints = await planSprints(tx, input.sprints, ctx);
  const priorityLevels = (await listPriorityLevels(tx, ctx.projectId)).map((l) => ({ key: l.key, name: l.name }));
  return { priorityLevels, statusIdByName, typeIdByName, statusMapping, typeMapping, statusesToCreate, typesToCreate, sprints };
}

// ── Read-only preview ───────────────────────────────────────────────────────

/** What a real run would do, as plain JSON for the wizard's review and mapping steps. */
export interface JiraMigrationPlanPreview {
  issueCount: number;
  minKeyNumber: number | null;
  maxKeyNumber: number | null;
  statusesToCreate: { name: string; category: "todo" | "in_progress" | "done"; column: JiraStatusColumnPlacement | null }[];
  typesToCreate: { name: string }[];
  /** One per JIRA priority: the key the run will write (the mapping's choice, or the suggestion) and that level's name. */
  priorities: { jiraName: string; kompastKey: string; kompastName: string }[];
  /** In plan order. `action` is what the run does with the sprint. */
  sprints: {
    jiraSprintId: number;
    jiraName: string;
    jiraState: "closed" | "active" | "future";
    state: "closed" | "active" | "future";
    number: number;
    action: "create" | "existing-active" | "already-imported";
  }[];
  people: { mapped: number; former: number };
  attachments: { total: number; totalBytes: number; migrated: number; migratedBytes: number; placeholders: number; placeholderBytes: number };
  /** The mapping's field choices, with the usage and samples the wizard shows. Empty on a mapping without a fields list. */
  fields: JiraPreviewField[];
  /** Used fields the loader handles itself (their values are written by the core fields or the history logic). */
  handledAutomatically: string[];
  /** Used fields whose values can't be migrated, with why. Never a choice. */
  notMigratable: { jiraName: string; usage: number; reason: JiraFieldReason }[];
}

/** One field choice in the preview: what the field is, and what the run writes it to. */
export interface JiraPreviewField {
  jiraFieldId: string;
  jiraName: string;
  schemaType: string | null;
  usage: number;
  samples: string[];
  action: "core" | "property" | "skip";
  target:
    | { kind: "core"; coreField: JiraCoreField }
    | { kind: "existing"; key: string; name: string; type: IssuePropertyType }
    | { kind: "new"; name: string; type: IssuePropertyType }
    | { kind: "skip" };
  /** The property (or core field) the field would become on its own, when it's migratable at all. The wizard prefills a new property from it. */
  suggested: { name: string; type: IssuePropertyType; transform?: "secondsToHours" } | null;
  transform?: "secondsToHours";
  /** A person field that holds a list: only its first value is taken. */
  firstValueOnly: boolean;
  /** Why the field is skipped by its nature (a board colour, an app-computed value). Not set when the user chose to skip it. */
  reason?: JiraFieldReason;
}

/**
 * The plan a real run would apply, built from the saved discovery and mapping.
 * It calls the same planJiraImport a dry run uses, so the preview can't drift
 * from the run. Reads only: writes nothing.
 */
export async function previewJiraMigrationPlan(tx: Tx, ctx: PlanTarget, discovery: JiraDiscovery, mapping: JiraMigrationMapping): Promise<JiraMigrationPlanPreview> {
  const plan = await planJiraImport(tx, ctx, {
    statuses: discovery.statuses,
    types: discovery.issueTypes.map((t) => ({ name: t.name })),
    sprints: discovery.sprints,
    mapping,
  });

  const limit = mapping.attachmentMaxBytes;
  const fits = (size: number) => limit === null || size <= limit;
  const migrated = discovery.attachmentSizes.filter(fits);
  const placeholders = discovery.attachmentSizes.filter((size) => !fits(size));
  const sum = (sizes: number[]) => sizes.reduce((a, b) => a + b, 0);

  return {
    issueCount: discovery.issueCount,
    minKeyNumber: discovery.minKeyNumber,
    maxKeyNumber: discovery.maxKeyNumber,
    statusesToCreate: plan.statusesToCreate.map((s) => ({ name: s.name, category: s.category, column: s.column ?? null })),
    typesToCreate: plan.typesToCreate.map((t) => ({ name: t.name })),
    priorities: (discovery.priorities ?? []).map((p) => {
      const kompastKey = resolvePriorityKey(p.name, plan.priorityLevels, mapping.priorities ?? []);
      return { jiraName: p.name, kompastKey, kompastName: plan.priorityLevels.find((l) => l.key === kompastKey)?.name ?? kompastKey };
    }),
    sprints: plan.sprints.map((p) => ({
      jiraSprintId: p.jira.id,
      jiraName: p.jira.name,
      jiraState: p.jira.state,
      state: p.state,
      number: p.number,
      action: p.action,
    })),
    people: {
      mapped: mapping.people.filter((p) => p.action === "map").length,
      former: mapping.people.filter((p) => p.action === "former").length,
    },
    attachments: {
      total: discovery.attachmentSizes.length,
      totalBytes: sum(discovery.attachmentSizes),
      migrated: migrated.length,
      migratedBytes: sum(migrated),
      placeholders: placeholders.length,
      placeholderBytes: sum(placeholders),
    },
    ...(await previewFieldsOf(tx, ctx, discovery, mapping)),
  };
}

/**
 * The field part of the preview: the mapping's choices with their usage and
 * samples, the fields handled automatically, and the ones that can't be
 * migrated. Reads the project's properties to name an existing target.
 */
async function previewFieldsOf(
  tx: Tx,
  ctx: PlanTarget,
  discovery: JiraDiscovery,
  mapping: JiraMigrationMapping,
): Promise<Pick<JiraMigrationPlanPreview, "fields" | "handledAutomatically" | "notMigratable">> {
  const usage = discovery.fieldUsage ?? {};
  const optionsOf = discovery.fieldOptions ?? {};
  const shapes = new Map((discovery.fields ?? []).map((f) => [f.id, f]));
  const properties = await listIssuePropertyDefinitions(tx, ctx.projectId);

  const fields = (mapping.fields ?? []).map((f: JiraFieldMapping): JiraPreviewField => {
    const shape = shapes.get(f.jiraFieldId);
    const classification = shape ? classifyJiraField(shape, (optionsOf[f.jiraFieldId] ?? []).map((o) => o.value)) : null;
    const suggested = classification?.kind === "migrate" ? { name: classification.create.name, type: classification.create.type, ...(classification.transform ? { transform: classification.transform } : {}) } : null;

    let target: JiraPreviewField["target"] = { kind: "skip" };
    if (f.action === "core" && f.coreField) target = { kind: "core", coreField: f.coreField };
    else if (f.action === "property" && f.propertyKey) {
      const def = properties.find((p) => p.key === f.propertyKey);
      target = { kind: "existing", key: f.propertyKey, name: def?.name ?? f.propertyKey, type: def?.type ?? "text" };
    } else if (f.action === "property" && f.create) target = { kind: "new", name: f.create.name, type: f.create.type };

    return {
      jiraFieldId: f.jiraFieldId,
      jiraName: f.jiraName,
      schemaType: shape?.schemaType ?? null,
      usage: usage[f.jiraFieldId] ?? 0,
      samples: discovery.fieldSamples?.[f.jiraFieldId] ?? [],
      action: f.action,
      target,
      suggested,
      ...(f.transform ? { transform: f.transform } : {}),
      firstValueOnly: classification?.kind === "migrate" && !!classification.firstValueOnly,
      ...(classification?.kind === "skip" ? { reason: classification.reason } : {}),
    };
  });

  const used = (discovery.fields ?? []).filter((f) => (usage[f.id] ?? 0) > 0);
  const handledAutomatically = used.filter((f) => isHandledJiraField(f)).map((f) => f.name);
  const notMigratable = used
    .map((f) => ({ f, classification: classifyJiraField(f, (optionsOf[f.id] ?? []).map((o) => o.value)) }))
    .flatMap(({ f, classification }) => (classification.kind === "notMigratable" ? [{ jiraName: f.name, usage: usage[f.id] ?? 0, reason: classification.reason }] : []))
    .sort((a, b) => b.usage - a.usage || a.jiraName.localeCompare(b.jiraName));

  return { fields, handledAutomatically, notMigratable };
}

// ── Prepare (writes the idempotent set-up) ──────────────────────────────────

/**
 * Creates whatever the load needs before any issue is written: missing
 * statuses and types, and every sprint that isn't already imported. Creating
 * the same thing twice is a no-op, so calling this again (a re-run) creates
 * nothing new. The result is plain JSON, safe to store in a cursor.
 */
export async function prepareJiraImport(tx: Tx, ctx: JiraLoadContext, input: JiraImportInput): Promise<PreparedJiraImport> {
  const plan = await planJiraImport(tx, ctx, input);

  let typesCreated = 0;
  let statusesCreated = 0;
  let sprintsCreated = 0;

  for (const t of plan.typesToCreate) {
    const { typeId } = await createIssueType(tx, { projectId: ctx.projectId, name: t.name });
    plan.typeIdByName.set(t.name.toLowerCase(), typeId);
    typesCreated++;
  }
  // Statuses created after the same column are placed in order: each new
  // column goes after the one the previous status created there, so they
  // end up in the mapping's order rather than reversed.
  const lastCreatedAfter = new Map<string | null, string>();
  for (const s of plan.statusesToCreate) {
    const base = { projectId: ctx.projectId, boardId: ctx.boardId, name: s.name, category: s.category };
    const placement = s.column;
    let statusId: string;
    if (placement?.mode === "join") {
      statusId = (await createWorkflowStatus(tx, { ...base, columnId: placement.columnId })).statusId;
    } else if (placement?.mode === "new") {
      const anchor = placement.afterColumnId;
      const after = lastCreatedAfter.has(anchor) ? lastCreatedAfter.get(anchor)! : anchor;
      const created = await createWorkflowStatus(tx, { ...base, afterColumnId: after });
      lastCreatedAfter.set(anchor, created.columnId);
      statusId = created.statusId;
    } else {
      statusId = (await createWorkflowStatus(tx, base)).statusId;
    }
    plan.statusIdByName.set(s.name.toLowerCase(), statusId);
    statusesCreated++;
  }

  // Sprints before issues, so the membership pass can attach issues to them.
  for (const p of plan.sprints) {
    if (p.action !== "create") continue;
    const { sprintId } = await importSprint(tx, {
      organizationId: ctx.organizationId,
      boardId: ctx.boardId,
      name: p.jira.name,
      preferredNumber: p.number,
      goal: p.jira.goal || undefined,
      state: p.state,
      startAt: p.startAt,
      endAt: p.endAt,
      createdAt: p.createdAt,
      // Sprint Action / Retrospective docs only for sprints still being worked on.
      actorUserId: p.state === "closed" ? undefined : ctx.actorUserId,
    });
    p.kompastSprintId = sprintId;
    await upsertExternalRef(tx, {
      organizationId: ctx.organizationId,
      source: "jira",
      sourceId: sprintRefId(p.jira.id),
      entityType: "sprint",
      entityId: sprintId,
      importRunId: ctx.importRunId,
    });
    sprintsCreated++;
  }

  // Former JIRA members: one placeholder user each (find-or-create), so every batch can attribute to them.
  const formerUserIdByAccount: Record<string, string> = {};
  let formerMembersCreated = 0;
  for (const person of input.mapping?.people ?? []) {
    if (person.action !== "former") continue;
    const { userId, created } = await ensureImportedFormerUser(tx, {
      organizationId: ctx.organizationId,
      accountId: person.accountId,
      name: person.displayName,
      importRunId: ctx.importRunId,
    });
    formerUserIdByAccount[person.accountId] = userId;
    if (created) formerMembersCreated++;
  }

  // The mapping's fields: core targets, existing properties, and properties to create. A property is reused when
  // a property with the same name and type exists (a re-run creates nothing), and a select's options come from
  // the discovery, in usage order.
  let propertiesCreated = 0;
  let fieldTargets: PreparedFieldTarget[] | undefined;
  if (input.mapping?.fields) {
    const known = (await listIssuePropertyDefinitions(tx, ctx.projectId)).map((d) => ({ key: d.key, name: d.name, type: d.type, isCore: d.isCore }));
    fieldTargets = [];
    for (const f of input.mapping.fields) {
      if (f.action === "skip") continue;
      const base = { jiraFieldId: f.jiraFieldId, jiraName: f.jiraName };
      if (f.action === "core" && f.coreField) {
        fieldTargets.push({ ...base, kind: "core", coreField: f.coreField, type: JIRA_CORE_FIELD_TYPE[f.coreField] });
        continue;
      }
      if (f.propertyKey) {
        const existing = known.find((p) => !p.isCore && p.key === f.propertyKey);
        if (!existing) throw new Error(`${f.jiraName}: the property it writes to no longer exists. Choose it again.`);
        fieldTargets.push({ ...base, kind: "property", propertyKey: existing.key, type: existing.type, ...(f.transform && existing.type === "number" ? { transform: f.transform } : {}) });
        continue;
      }
      if (!f.create) continue;
      const wanted = f.create;
      const reuse = known.find((p) => !p.isCore && p.type === wanted.type && p.name.trim().toLowerCase() === wanted.name.trim().toLowerCase());
      if (reuse) {
        fieldTargets.push({ ...base, kind: "property", propertyKey: reuse.key, type: reuse.type, ...(f.transform && reuse.type === "number" ? { transform: f.transform } : {}) });
        continue;
      }
      let options: { value: string; label: string }[] | undefined;
      if (wanted.type === "select" || wanted.type === "multiSelect") {
        const values = input.fieldOptions?.[f.jiraFieldId] ?? [];
        if (values.length === 0) throw new Error(`${f.jiraName}: no options are known for it yet. Scan JIRA again, then retry.`);
        options = values.map((o) => ({ value: o.value, label: o.value }));
      }
      const { key } = await createIssuePropertyDefinition(tx, { projectId: ctx.projectId, name: wanted.name, type: wanted.type, ...(options ? { options } : {}) });
      known.push({ key, name: wanted.name, type: wanted.type, isCore: false });
      propertiesCreated++;
      fieldTargets.push({ ...base, kind: "property", propertyKey: key, type: wanted.type, ...(f.transform && wanted.type === "number" ? { transform: f.transform } : {}) });
    }
  }

  return {
    statusIdByName: Object.fromEntries(plan.statusIdByName),
    typeIdByName: Object.fromEntries(plan.typeIdByName),
    priorityLevels: plan.priorityLevels,
    priorityMapping: input.mapping?.priorities ?? [],
    formerUserIdByAccount,
    statusMapping: plan.statusMapping,
    typeMapping: plan.typeMapping,
    sprintMapping: plan.sprints.map(toSprintMapping),
    sprints: plan.sprints.map((p, order) => ({
      jiraSprintId: p.jira.id,
      jiraName: p.jira.name,
      state: p.state,
      number: p.number,
      action: p.action,
      kompastSprintId: p.kompastSprintId,
      startAt: p.startAt?.toISOString() ?? null,
      endAt: p.endAt?.toISOString() ?? null,
      order,
    })),
    ...(fieldTargets ? { fieldTargets } : {}),
    counts: { statusesCreated, typesCreated, sprintsCreated, formerMembersCreated, propertiesCreated },
  };
}

// ── One batch of issues ─────────────────────────────────────────────────────

type LoadedSprint = Omit<PreparedSprint, "startAt" | "endAt"> & { startAt?: Date; endAt?: Date };

/** The trailing number of a JIRA key: ZTRD-123 → 123. */
function keyNumberOf(jiraKey: string): number | null {
  const match = /-(\d+)$/.exec(jiraKey);
  return match ? Number(match[1]) : null;
}

/** The project part of a JIRA key: "ZTRD-123" → "ZTRD". Undefined for no issues. */
function jiraProjectKeyOf(issues: JiraIssue[]): string | undefined {
  const match = /^(.+)-\d+$/.exec(issues[0]?.key ?? "");
  return match?.[1];
}

/** issue.story_points is an integer column, so JIRA's (possibly fractional) estimate rounds. */
function storyPointsOf(issue: JiraIssue, fieldId: string | undefined): number | undefined {
  if (!fieldId) return undefined;
  const raw = (issue.fields as unknown as Record<string, unknown>)[fieldId];
  return typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : undefined;
}

/**
 * Loads one batch of already-fetched issues: creates them (passes 1, 2, 2b,
 * 3-6). Parents and link targets that aren't in this batch (or an earlier one)
 * are returned as deferred, to be resolved by finalizeJiraImport once every
 * batch is in. Only issues created in this batch get comments, worklogs, links,
 * attachments, changelog and watchers, so a re-run never duplicates them.
 *
 * Every write for an issue runs in its own savepoint (tx.transaction nests as
 * SAVEPOINT), so one failing statement rolls back only that step. The rest of
 * the page, and the page's transaction, carry on.
 */
export async function loadJiraIssueBatch(tx: Tx, issues: JiraIssue[], ctx: JiraLoadContext, prepared: PreparedJiraImport): Promise<JiraBatchResult> {
  const counts = emptyCounts();
  const errors: JiraLoadReport["errors"] = [];
  const notes: JiraLoadReport["notes"] = [];
  const deferredParents: DeferredParent[] = [];
  const deferredLinks: DeferredLink[] = [];

  const sprintByJiraId = new Map<number, LoadedSprint & { order: number }>(
    prepared.sprints.map((p) => [
      p.jiraSprintId,
      { ...p, startAt: p.startAt ? new Date(p.startAt) : undefined, endAt: p.endAt ? new Date(p.endAt) : undefined },
    ]),
  );
  const typeIdOf = (name: string) => idOf(prepared.typeIdByName, name.toLowerCase());
  // A cursor from before priorityLevels was stored reads the project's levels once per batch.
  const priorityLevels = prepared.priorityLevels ?? (await listPriorityLevels(tx, ctx.projectId)).map((l) => ({ key: l.key, name: l.name }));
  const priorityMapping = prepared.priorityMapping ?? [];
  const statusIdOf = (name: string) => idOf(prepared.statusIdByName, name.toLowerCase());

  const [projectRow] = await tx.select({ key: schema.project.key, teamId: schema.project.teamId }).from(schema.project).where(eq(schema.project.id, ctx.projectId));
  const kompastProject = { projectKey: projectRow?.key ?? "", teamId: projectRow?.teamId ?? "" };
  const jiraProjectKey = ctx.jiraProjectKey ?? jiraProjectKeyOf(issues) ?? "";
  const jiraBase = ctx.jiraBaseUrl?.replace(/\/+$/, "");

  // The mapped resolver first (a member of the project), then the former-member placeholder for anyone the mapping marks "former".
  const formerIds = prepared.formerUserIdByAccount ?? {};
  const formerOf = (user: JiraUser | null | undefined): string | null =>
    user && Object.prototype.hasOwnProperty.call(formerIds, user.accountId) ? formerIds[user.accountId]! : null;
  const resolveMapped = ctx.resolveUserId ?? (() => null);
  const resolveUser = (user: JiraUser | null | undefined): string | null => (user ? (resolveMapped(user) ?? formerOf(user)) : null);

  // The mapping's field targets (undefined on a mapping without a fields list: the 3a story-points rule applies then).
  const fieldTargets = prepared.fieldTargets;
  // The custom properties this batch writes into, with their options. A value the property doesn't list yet is appended once the issue is written.
  const propertyDefs = new Map<string, { id: string; options: { value: string; label: string }[] }>();
  const dirtyPropertyKeys = new Set<string>();
  if (fieldTargets?.some((t) => t.kind === "property")) {
    const rows = await tx.select().from(schema.issuePropertyDefinition).where(eq(schema.issuePropertyDefinition.projectId, ctx.projectId));
    for (const row of rows) {
      if (!row.isCore) propertyDefs.set(row.key, { id: row.id, options: ((row.options as unknown as { value: string; label: string }[] | null) ?? []).slice() });
    }
  }

  const planFieldsOf = (issue: JiraIssue): FieldPlan => planFieldValues(issue, fieldTargets, resolveUser, propertyDefs);
  /** Counts a written issue's field plan, and queues the options it added (the property rows are written at the end of the batch). */
  const applyFieldPlan = (plan: FieldPlan, issueKey: string) => {
    counts.fieldValuesWritten += plan.written;
    counts.fieldValuesSkipped += plan.skipped;
    if (plan.roundedStoryPoints) counts.storyPointsRounded++;
    for (const error of plan.errors) errors.push({ issueKey, error });
    for (const n of plan.newOptions) {
      const def = propertyDefs.get(n.propertyKey);
      if (!def || def.options.some((o) => o.value === n.value)) continue;
      def.options.push({ value: n.value, label: n.value });
      dirtyPropertyKeys.add(n.propertyKey);
      counts.propertyOptionsAdded++;
    }
  };

  // Every person this batch mentions, by account, so a mention or a history actor resolves with its email and name.
  const userByAccount = new Map<string, JiraUser>();
  const noteUser = (user: JiraUser | null | undefined) => {
    if (user?.accountId && !userByAccount.has(user.accountId)) userByAccount.set(user.accountId, user);
  };
  for (const issue of issues) {
    noteUser(issue.fields.reporter);
    noteUser(issue.fields.assignee);
    noteUser(issue.fields.creator);
    for (const c of issue.fields.comment?.comments ?? []) noteUser(c.author);
    for (const w of issue.fields.worklog?.worklogs ?? []) noteUser(w.author);
    for (const h of issue.changelog?.histories ?? []) noteUser(h.author);
    for (const w of issue.watchersList ?? []) noteUser(w);
    for (const a of issue.fields.attachment ?? []) noteUser(a.author);
  }

  const issueKeyNumberFor = (jiraKey: string): number | null => {
    const match = /^(.+)-(\d+)$/.exec(jiraKey);
    return match && jiraProjectKey && match[1] === jiraProjectKey ? Number(match[2]) : null;
  };
  /** The JIRA attachment ids each issue's converted text refers to inline, collected as its blocks are made. */
  const inlineAttachmentIdsByKey = new Map<string, Set<string>>();
  /** An ADF body (description or comment) as BlockNote blocks, with this issue's attachments for media. */
  const blocksOf = convertBodyOf({
    resolveUser,
    userByAccount,
    jiraBaseUrl: ctx.jiraBaseUrl,
    jiraProjectKey,
    kompastProject,
    issueKeyNumberFor,
    counts,
    inlineIdsByKey: inlineAttachmentIdsByKey,
  });

  const kompastIssueIdByJiraKey = new Map<string, string>();
  // Only issues actually CREATED in this run get passes 2b-6 below. A skipped
  // (already-imported) issue keeps whatever those passes gave it from its original
  // run. Without this, re-running the same import would duplicate every
  // comment/worklog/link on each run, which external_ref exists to prevent.
  const newlyCreatedKeys = new Set<string>();

  // Pass 1: create (or, on a re-run, recognize-and-skip) every issue.
  for (const issue of issues) {
    try {
      const outcome = await tx.transaction(async (sp) => {
        const existingRef = await resolveExternalRef(sp, ctx.organizationId, "jira", issue.key);
        if (existingRef) return { skipped: true, issueId: existingRef.entityId, keySeq: 0, plan: null };

        const reporterId = resolveUser(issue.fields.reporter) ?? ctx.actorUserId;
        const assigneeId = resolveUser(issue.fields.assignee) ?? undefined;
        const description = blocksOf(issue.fields.description, issue.fields.attachment, issue.key);
        const resolution = issue.fields.resolution?.name;
        // With a fields list, its targets decide the core fields; the automatic JIRA dates and estimate fill in when the mapping says nothing.
        const plan = fieldTargets ? planFieldsOf(issue) : null;

        const created = await createIssue(sp, {
          organizationId: ctx.organizationId,
          projectId: ctx.projectId,
          typeId: typeIdOf(issue.fields.issuetype.name)!,
          statusId: statusIdOf(issue.fields.status.name)!,
          title: issue.fields.summary,
          reporterId,
          assigneeId,
          priority: resolvePriorityKey(issue.fields.priority?.name, priorityLevels, priorityMapping),
          descriptionJson: description.length > 0 ? (description as unknown as Json) : undefined,
          labels: issue.fields.labels ?? [],
          estimateSeconds: plan?.core.estimateSeconds ?? issue.fields.timeoriginalestimate ?? undefined,
          dueDate: plan?.core.dueDate ?? (issue.fields.duedate ? new Date(issue.fields.duedate) : undefined),
          startDate: plan?.core.startDate,
          storyPoints: plan ? plan.core.storyPoints : storyPointsOf(issue, ctx.storyPointsFieldId),
          customFields: {
            jira: {
              originalKey: issue.key,
              fixVersions: (issue.fields.fixVersions ?? []).map((v) => v.name),
              components: (issue.fields.components ?? []).map((c) => c.name),
              ...(resolution ? { resolution } : {}),
            },
            ...(plan?.props ?? {}),
          },
          createdAt: new Date(issue.fields.created),
          // JIRA's number is kept when it's free; createIssue falls back to the next free one when it isn't.
          keySeq: keyNumberOf(issue.key) ?? undefined,
          origin: "import",
        });

        await upsertExternalRef(sp, {
          organizationId: ctx.organizationId,
          source: "jira",
          sourceId: issue.key,
          sourceUrl: jiraBase ? `${jiraBase}/browse/${issue.key}` : undefined,
          entityType: "issue",
          entityId: created.issueId,
          importRunId: ctx.importRunId,
        });
        return { skipped: false, issueId: created.issueId, keySeq: created.keySeq, plan };
      });

      kompastIssueIdByJiraKey.set(issue.key, outcome.issueId);
      if (outcome.skipped) {
        counts.issuesSkipped++;
        continue;
      }
      newlyCreatedKeys.add(issue.key);
      counts.issuesCreated++;
      if (outcome.plan) applyFieldPlan(outcome.plan, issue.key);
      const requested = keyNumberOf(issue.key);
      if (requested !== null && outcome.keySeq !== requested) {
        counts.issuesRenumbered++;
        notes.push({ issueKey: issue.key, note: `renumbered to ${kompastProject.projectKey}-${outcome.keySeq}: number already used` });
      }
    } catch (err) {
      errors.push({ issueKey: issue.key, error: errorMessage(err) });
    }
  }

  // Pass 2: parent linkage. A parent not found yet is deferred, since it may sit in a later batch.
  for (const issue of issues) {
    const parentKey = issue.fields.parent?.key;
    if (!parentKey) continue;
    const childId = kompastIssueIdByJiraKey.get(issue.key);
    if (!childId) continue; // this issue itself errored in pass 1
    // The parent existed from JIRA's start, so its history row is backdated to the child's created time and
    // attributed to the child's reporter (the importer when unresolved), not stamped today as the importer.
    const historyActorId = resolveUser(issue.fields.reporter) ?? ctx.actorUserId;
    try {
      await tx.transaction(async (sp) => {
        const parentId = kompastIssueIdByJiraKey.get(parentKey) ?? (await resolveExternalRef(sp, ctx.organizationId, "jira", parentKey))?.entityId ?? null;
        if (!parentId) {
          deferredParents.push({ childKey: issue.key, parentKey, updatedAt: issue.fields.updated, createdAt: issue.fields.created, historyActorId });
          return;
        }
        await updateIssue(sp, childId, {
          parentId,
          actorId: ctx.actorUserId,
          origin: "import",
          historyAt: toDate(issue.fields.created),
          historyActorId,
        });
        counts.parentLinksResolved++;
      });
    } catch (err) {
      errors.push({ issueKey: issue.key, error: `parent link: ${errorMessage(err)}` });
    }
  }

  // Pass 2b: sprint membership for newly created issues. JIRA's Sprint field
  // lists every sprint the issue was ever on. The issue ends up on its open
  // (active/future) sprint if it has one; otherwise on its last closed sprint
  // if it's done there (like completeSprint leaves done issues); otherwise in
  // the backlog. Earlier sprints are kept as history (removedAt = when that
  // sprint closed), so carry-over shows in the sprint reports.
  const now = new Date();
  const ranks = sprintRanksOf(sprintByJiraId);
  for (const issue of issues) {
    if (!newlyCreatedKeys.has(issue.key)) continue;
    const issueId = kompastIssueIdByJiraKey.get(issue.key)!;
    try {
      await tx.transaction(async (sp) => {
        const onSprints = extractJiraSprints(issue)
          .map((s) => sprintByJiraId.get(s.id))
          .filter((p): p is NonNullable<typeof p> => !!p?.kompastSprintId)
          .sort((a, b) => a.order - b.order);
        if (onSprints.length === 0) {
          counts.issuesInBacklog++;
          return;
        }

        const currentId = currentJiraSprintIdOf(issue, ranks);
        const current = onSprints.find((p) => p.jiraSprintId === currentId);
        const created = new Date(issue.fields.created);

        const memberships: ImportedSprintMembership[] = onSprints.map((p) => {
          const sprintStart = p.startAt && p.startAt < now ? p.startAt : now;
          const addedAt = p.state === "future" ? (created < now ? now : created) : created > sprintStart ? created : sprintStart;
          let removedAt: Date | null = null;
          if (p !== current) {
            removedAt = p.state === "closed" ? (p.endAt ?? now) : now;
            if (removedAt < addedAt) removedAt = addedAt;
          }
          return { sprintId: p.kompastSprintId!, addedAt, removedAt, plannedAtStart: p.state !== "future" && (!p.startAt || addedAt <= p.startAt) };
        });

        await importIssueSprintMemberships(sp, {
          issueId,
          boardId: ctx.boardId,
          memberships,
          currentSprintId: current?.kompastSprintId ?? null,
          currentSprintState: current?.state,
        });
        counts.sprintMembershipsCreated += memberships.length;
        if (!current) counts.issuesInBacklog++;
      });
    } catch (err) {
      errors.push({ issueKey: issue.key, error: `sprint: ${errorMessage(err)}` });
    }
  }

  const historyChangeOf = historyMapperOf({ fieldTargets, storyPointsFieldId: ctx.storyPointsFieldId, priorityLevels, priorityMapping, resolveUser, userByAccount, sprintByJiraId }).change;

  // Pass 3-6: comments, worklogs, issue links, attachments, changelog and
  // watchers, ONLY for issues newly created in THIS run (see newlyCreatedKeys).
  for (const issue of issues) {
    if (!newlyCreatedKeys.has(issue.key)) continue;
    const issueId = kompastIssueIdByJiraKey.get(issue.key)!;
    const attachments = issue.fields.attachment ?? [];

    for (const c of issue.fields.comment?.comments ?? []) {
      try {
        await tx.transaction(async (sp) => {
          const { commentId } = await addComment(sp, {
            issueId,
            authorId: resolveUser(c.author) ?? ctx.actorUserId,
            bodyJson: blocksOf(c.body, attachments, issue.key) as unknown as Json,
            origin: "import",
            createdAt: new Date(c.created),
          });
          // JIRA's own edit time, so a later sync can tell whether JIRA has a newer body for this comment.
          const commentUpdatedAt = toDate(c.updated);
          if (commentUpdatedAt) await sp.update(schema.issueComment).set({ updatedAt: commentUpdatedAt }).where(eq(schema.issueComment.id, commentId));
          if (c.id) {
            await upsertExternalRef(sp, {
              organizationId: ctx.organizationId,
              source: "jira",
              sourceId: `${issue.key}/${c.id}`,
              sourceUrl: jiraBase ? `${jiraBase}/browse/${issue.key}?focusedCommentId=${c.id}` : undefined,
              entityType: "comment",
              entityId: commentId,
              importRunId: ctx.importRunId,
            });
          }
        });
        counts.commentsCreated++;
      } catch (err) {
        errors.push({ issueKey: issue.key, error: `comment: ${errorMessage(err)}` });
      }
    }

    for (const w of issue.fields.worklog?.worklogs ?? []) {
      try {
        await tx.transaction(async (sp) => {
          const { worklogId } = await logWork(sp, {
            issueId,
            userId: resolveUser(w.author) ?? ctx.actorUserId,
            seconds: w.timeSpentSeconds,
            note: w.comment ? adfToPlainText(w.comment) : undefined,
            loggedAt: new Date(w.started),
          });
          if (w.id) {
            await upsertExternalRef(sp, {
              organizationId: ctx.organizationId,
              source: "jira",
              sourceId: `${issue.key}/${w.id}`,
              entityType: "worklog",
              entityId: worklogId,
              importRunId: ctx.importRunId,
            });
          }
        });
        counts.worklogsCreated++;
      } catch (err) {
        errors.push({ issueKey: issue.key, error: `worklog: ${errorMessage(err)}` });
      }
    }

    // Only the outward side is loaded — JIRA reports the same link from
    // both issues involved (this issue's outwardIssue, the other's
    // inwardIssue), so loading just one side avoids creating it twice.
    for (const link of issue.fields.issuelinks ?? []) {
      if (!link.outwardIssue) continue;
      const linkType = mapLinkType(link.type.name);
      const toIssueId = kompastIssueIdByJiraKey.get(link.outwardIssue.key) ?? (await resolveExternalRef(tx, ctx.organizationId, "jira", link.outwardIssue.key))?.entityId;
      if (!toIssueId) {
        deferredLinks.push({ fromKey: issue.key, toKey: link.outwardIssue.key, type: linkType });
        continue;
      }
      try {
        await tx.transaction((sp) => linkIssues(sp, { fromIssueId: issueId, toIssueId, type: linkType }));
        counts.linksCreated++;
      } catch (err) {
        errors.push({ issueKey: issue.key, error: `link: ${errorMessage(err)}` });
      }
    }

    if (ctx.migrationAttachments) {
      const inlineIds = inlineAttachmentIdsByKey.get(issue.key) ?? new Set<string>();
      for (const att of attachments) {
        try {
          const outcome = await tx.transaction((sp) =>
            writeAttachmentPlaceholder(sp, {
              ctx,
              issueId,
              issueKey: issue.key,
              issueCreated: issue.fields.created,
              att,
              inline: inlineIds.has(att.id),
              maxBytes: ctx.migrationAttachments!.maxBytes,
              resolveUser,
              jiraBase,
            }),
          );
          if (outcome === "skipped") counts.attachmentsSkipped++;
          else if (outcome === "pending") counts.attachmentsQueued++;
          else counts.attachmentsNotMigrated++;
          const limit = ctx.migrationAttachments!.maxBytes;
          if (outcome !== "skipped" && inlineIds.has(att.id) && limit !== null && att.size > limit) counts.inlineAttachmentsOverLimit++;
        } catch (err) {
          errors.push({ issueKey: issue.key, error: `attachment ${att.filename}: ${errorMessage(err)}` });
        }
      }
    } else if (ctx.downloadAttachment) {
      for (const att of attachments) {
        try {
          const { data, contentType } = await ctx.downloadAttachment(att.content);
          await tx.transaction(async (sp) => {
            const { attachmentId } = await attachIssueFile(sp, { issueId, uploaderId: ctx.actorUserId, fileName: att.filename, contentType: contentType || att.mimeType, data });
            if (att.id) {
              await upsertExternalRef(sp, {
                organizationId: ctx.organizationId,
                source: "jira",
                sourceId: `${issue.key}/${att.id}`,
                sourceUrl: att.content,
                entityType: "attachment",
                entityId: attachmentId,
                importRunId: ctx.importRunId,
              });
            }
          });
          counts.attachmentsCreated++;
        } catch (err) {
          errors.push({ issueKey: issue.key, error: `attachment ${att.filename}: ${errorMessage(err)}` });
        }
      }
    } else {
      counts.attachmentsSkipped += attachments.length;
    }

    for (const history of issue.changelog?.histories ?? []) {
      const createdAt = new Date(history.created);
      const actorId = resolveUser(history.author) ?? ctx.actorUserId;
      for (const item of history.items) {
        if (item.field === "status") {
          const fromStatusId = item.fromString ? (statusIdOf(item.fromString) ?? null) : null;
          const toStatusId = item.toString ? statusIdOf(item.toString) : undefined;
          if (!toStatusId) continue; // a status renamed/deleted since this changelog entry — nothing sensible to record it as
          try {
            await tx.transaction((sp) => recordHistoricalStatusChange(sp, { issueId, actorId, fromStatusId, toStatusId, createdAt }));
            counts.historicalTransitionsRecorded++;
          } catch (err) {
            errors.push({ issueKey: issue.key, error: `changelog: ${errorMessage(err)}` });
          }
          continue;
        }

        const change = historyChangeOf(item);
        if (!change) continue;
        try {
          await tx.transaction((sp) => recordHistoricalFieldChange(sp, { issueId, actorId, field: change.field, fromValue: change.fromValue, toValue: change.toValue, createdAt }));
          counts.historyEntriesRecorded++;
        } catch (err) {
          errors.push({ issueKey: issue.key, error: `history ${item.field}: ${errorMessage(err)}` });
        }
      }
    }

    // A watcher counts as mapped when the mapping resolves them to a real member. Former members are
    // placeholders, and anyone unresolved is skipped. Duplicates collapse to one row (issue_watcher is unique).
    const watcherIds = new Set<string>();
    for (const w of issue.watchersList ?? []) {
      const userId = resolveUser(w);
      const mapped = userId !== null && userId !== formerOf(w);
      if (!userId || !mapped) {
        counts.watchersSkipped++;
        continue;
      }
      if (watcherIds.has(userId)) continue;
      watcherIds.add(userId);
      try {
        await tx.transaction((sp) => setWatching(sp, { issueId, userId, watching: true }));
        counts.watchersAdded++;
      } catch (err) {
        errors.push({ issueKey: issue.key, error: `watcher: ${errorMessage(err)}` });
      }
    }

    // Last, so no later write in this run (the worklog totals above bump updated_at) overwrites them.
    const updatedAt = toDate(issue.fields.updated);
    const resolvedAt = toDate(issue.fields.resolutiondate ?? undefined);
    if (updatedAt || resolvedAt) {
      try {
        await tx.transaction((sp) =>
          sp
            .update(schema.issue)
            .set({ ...(updatedAt ? { updatedAt } : {}), ...(resolvedAt ? { resolvedAt } : {}) })
            .where(eq(schema.issue.id, issueId)),
        );
      } catch (err) {
        errors.push({ issueKey: issue.key, error: `timestamps: ${errorMessage(err)}` });
      }
    }
  }

  // Options a select or multi-select property didn't list yet, written once per batch.
  for (const key of dirtyPropertyKeys) {
    const def = propertyDefs.get(key)!;
    await tx
      .update(schema.issuePropertyDefinition)
      .set({ options: def.options as unknown as Json, updatedAt: new Date() })
      .where(eq(schema.issuePropertyDefinition.id, def.id));
  }

  return { counts, errors, deferredParents, deferredLinks, notes };
}

/**
 * The changelog mapping the loader and the sync share: one JIRA changelog item becomes the Kompast field change it
 * records (its field name, from and to values), or null when the field isn't migrated. The status field is not
 * mapped here (see recordHistoricalStatusChange). A mapped custom property is named customFields.<key>.
 */
function historyMapperOf(o: {
  fieldTargets: PreparedFieldTarget[] | undefined;
  storyPointsFieldId: string | undefined;
  priorityLevels: PriorityLevelRef[];
  priorityMapping: { jiraName: string; kompastKey: string }[];
  resolveUser: (user: JiraUser | null | undefined) => string | null;
  userByAccount: Map<string, JiraUser>;
  sprintByJiraId: Map<number, LoadedSprint & { order: number }>;
}): { change: (item: JiraChangelogItem) => { field: string; fromValue: string | null; toValue: string | null } | null } {
  const { fieldTargets, priorityLevels, priorityMapping, resolveUser, userByAccount, sprintByJiraId } = o;
  // Each history change is made for JIRA's own vocabulary. Status keeps its own
  // path (statusIdOf, recordHistoricalStatusChange). Everything else maps onto
  // the field names updateIssue writes, or jira.<field> where Kompast has none.
  const priorityKey = (name: string | null | undefined): string | null => (name ? resolvePriorityKey(name, priorityLevels, priorityMapping) : null);
  const isoDate = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const date = toDate(value);
    return date ? date.toISOString() : value;
  };
  const labelsText = (value: string | null | undefined): string | null => {
    const labels = (value ?? "").split(" ").filter(Boolean);
    return labels.length > 0 ? labels.join(", ") : null;
  };
  /** One side of an assignee change: the Kompast user id, null for unassigned, or ok:false when the person can't be resolved. */
  const userSide = (accountId: string | null | undefined, displayName: string | null | undefined): { ok: boolean; value: string | null } => {
    if (!accountId) return displayName ? { ok: false, value: displayName } : { ok: true, value: null };
    const userId = resolveUser(userByAccount.get(accountId) ?? { accountId, displayName: displayName ?? "" });
    return userId ? { ok: true, value: userId } : { ok: false, value: displayName ?? accountId };
  };
  /** One side of a Sprint change: the Kompast sprint of the last sprint id JIRA lists, when that sprint was imported. */
  const sprintSide = (raw: string | null | undefined, name: string | null | undefined): { ok: boolean; value: string | null } => {
    if (raw == null) return name ? { ok: false, value: name } : { ok: true, value: null };
    const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return { ok: true, value: null };
    const sprint = sprintByJiraId.get(Number(ids[ids.length - 1]));
    return sprint?.kompastSprintId ? { ok: true, value: sprint.kompastSprintId } : { ok: false, value: name ?? raw };
  };
  /** The mapped target a changelog item belongs to: by JIRA field id when the item has one, else by its field name. */
  const targetOfItem = (item: JiraChangelogItem) =>
    fieldTargets?.find((t) => (item.fieldId ? t.jiraFieldId === item.fieldId : t.jiraName.toLowerCase() === item.field.toLowerCase()));
  /** A mapped field's change, as the history names it: core fields by their own name, a property as customFields.<key>. */
  const targetChange = (item: JiraChangelogItem, target: NonNullable<ReturnType<typeof targetOfItem>>): { field: string; fromValue: string | null; toValue: string | null } => {
    if (target.kind === "core") {
      const dated = target.coreField === "dueDate" || target.coreField === "startDate";
      return { field: target.coreField!, fromValue: dated ? isoDate(item.fromString) : (item.fromString ?? null), toValue: dated ? isoDate(item.toString) : (item.toString ?? null) };
    }
    const field = `customFields.${target.propertyKey}`;
    if (target.type === "person") {
      const from = userSide(item.from, item.fromString);
      const to = userSide(item.to, item.toString);
      return { field, fromValue: from.ok ? from.value : (item.fromString ?? null), toValue: to.ok ? to.value : (item.toString ?? null) };
    }
    if (target.type === "checkbox") return { field, fromValue: item.fromString ? "true" : null, toValue: item.toString ? "true" : null };
    return { field, fromValue: item.fromString || null, toValue: item.toString || null };
  };

  const change = (item: JiraChangelogItem): { field: string; fromValue: string | null; toValue: string | null } | null => {
    const mapped = targetOfItem(item);
    if (mapped) return targetChange(item, mapped);
    const name = item.field.toLowerCase();
    // The 3a rule: story points by the discovery's field id or name. A mapping with a fields list decides it instead.
    const isStoryPoints = !fieldTargets && ((!!o.storyPointsFieldId && item.fieldId === o.storyPointsFieldId) || name === "story point estimate" || name === "story points");
    if (isStoryPoints) return { field: "storyPoints", fromValue: item.fromString ?? null, toValue: item.toString ?? null };
    if (name === "assignee") {
      const from = userSide(item.from, item.fromString);
      const to = userSide(item.to, item.toString);
      return from.ok && to.ok
        ? { field: "assigneeId", fromValue: from.value, toValue: to.value }
        : { field: "jira.assignee", fromValue: item.fromString ?? null, toValue: item.toString ?? null };
    }
    if (name === "priority") return { field: "priority", fromValue: priorityKey(item.fromString), toValue: priorityKey(item.toString) };
    if (name === "duedate") return { field: "dueDate", fromValue: isoDate(item.fromString), toValue: isoDate(item.toString) };
    if (name === "summary") return { field: "title", fromValue: item.fromString ?? null, toValue: item.toString ?? null };
    if (name === "labels") return { field: "labels", fromValue: labelsText(item.fromString), toValue: labelsText(item.toString) };
    if (name === "sprint") {
      const from = sprintSide(item.from, item.fromString);
      const to = sprintSide(item.to, item.toString);
      return from.ok && to.ok
        ? { field: "sprint", fromValue: from.value, toValue: to.value }
        : { field: "jira.Sprint", fromValue: item.fromString ?? null, toValue: item.toString ?? null };
    }
    if (name === "resolution") return { field: "jira.resolution", fromValue: item.fromString ?? null, toValue: item.toString ?? null };
    return null;
  };

  return { change };
}

/**
 * The ADF-to-blocks conversion a load and a sync share. Returns (body, attachments, issueKey) => blocks. It counts the
 * converter's stats into `counts` and records each issue's inline attachment ids (collectInlineAttachmentIds) in
 * `inlineIdsByKey`, which the attachments phase reads.
 */
function convertBodyOf(o: {
  resolveUser: (user: JiraUser | null | undefined) => string | null;
  userByAccount: Map<string, JiraUser>;
  jiraBaseUrl: string | undefined;
  jiraProjectKey: string;
  kompastProject: { projectKey: string; teamId: string };
  issueKeyNumberFor: (jiraKey: string) => number | null;
  counts: JiraLoadReport["counts"];
  inlineIdsByKey: Map<string, Set<string>>;
}): (body: unknown, attachments: JiraAttachment[] | undefined, issueKey: string) => BlockNode[] {
  return (body, attachments, issueKey) => {
    const converted = adfToBlocks(body, {
      resolveUser: (accountId) => {
        const userId = o.resolveUser(o.userByAccount.get(accountId) ?? { accountId, displayName: "" });
        return userId ? { userId, name: o.userByAccount.get(accountId)?.displayName ?? "" } : null;
      },
      jiraBaseUrl: o.jiraBaseUrl,
      projectKeyJira: o.jiraProjectKey,
      kompast: o.kompastProject,
      attachments: (attachments ?? []).map((a) => ({ id: a.id, filename: a.filename, content: a.content, mimeType: a.mimeType })),
      issueKeyNumberFor: o.issueKeyNumberFor,
    });
    // Converter stats, which were dropped before. Counted when converted; an issue whose create then fails still counts its converted media.
    o.counts.inlineMediaLinked += converted.stats.mediaMatched;
    o.counts.inlineMediaUnmatched += converted.stats.mediaUnmatched;
    o.counts.unknownAdfNodes += Object.values(converted.stats.unknownNodes).reduce((sum, n) => sum + n, 0);
    const inlineIds = o.inlineIdsByKey.get(issueKey) ?? new Set<string>();
    collectInlineAttachmentIds(converted.blocks, inlineIds);
    o.inlineIdsByKey.set(issueKey, inlineIds);
    return converted.blocks;
  };
}

/**
 * Writes one JIRA attachment as a placeholder row, plus its external_ref (`<key>/<attachmentId>`), inside the caller's
 * savepoint. A file the limit allows (or an inline one under the hard cap) is "pending" for the attachments phase to
 * copy; any other is "not_migrated", and its inline references become links to JIRA at once. A file whose external_ref
 * already exists is "skipped": an earlier run recorded it, and its copy stays as it is.
 */
async function writeAttachmentPlaceholder(
  sp: Tx,
  o: {
    ctx: JiraLoadContext;
    issueId: string;
    issueKey: string;
    issueCreated: string;
    att: JiraAttachment;
    inline: boolean;
    maxBytes: number | null;
    resolveUser: (user: JiraUser | null | undefined) => string | null;
    jiraBase: string | undefined;
  },
): Promise<"skipped" | "pending" | "not_migrated"> {
  const { ctx, att } = o;
  const refKey = `${o.issueKey}/${att.id}`;
  if (await resolveExternalRef(sp, ctx.organizationId, "jira", refKey)) return "skipped";
  const fits = o.maxBytes === null || att.size <= o.maxBytes;
  const copyable = fits || (o.inline && att.size <= INLINE_ATTACHMENT_HARD_CAP_BYTES);
  const status = copyable ? "pending" : "not_migrated";
  const sourceUrl = o.jiraBase ? `${o.jiraBase}/secure/attachment/${att.id}/${encodeURIComponent(att.filename)}` : att.content;
  const { attachmentId } = await recordImportedAttachmentPlaceholder(sp, {
    issueId: o.issueId,
    uploaderId: o.resolveUser(att.author) ?? ctx.actorUserId,
    fileName: att.filename,
    contentType: att.mimeType,
    sizeBytes: att.size,
    status,
    sourceUrl,
    createdAt: toDate(att.created) ?? new Date(o.issueCreated),
  });
  await upsertExternalRef(sp, {
    organizationId: ctx.organizationId,
    source: "jira",
    sourceId: refKey,
    sourceUrl,
    entityType: "attachment",
    entityId: attachmentId,
    importRunId: ctx.importRunId,
  });
  if (status === "not_migrated") {
    // Its inline references (already written with the description and comments) become links to JIRA now.
    await rewriteIssueInlineAttachments(sp, o.issueId, att.id, (value) => linkUnavailableAttachment(value, att.id, { fileName: att.filename, sourceUrl }));
  }
  return status;
}

export interface FieldPlan {
  core: { storyPoints?: number; dueDate?: Date; startDate?: Date; estimateSeconds?: number };
  props: Record<string, Json>;
  written: number;
  skipped: number;
  errors: string[];
  roundedStoryPoints: boolean;
  newOptions: { propertyKey: string; value: string }[];
}

/**
 * One issue's field values, converted against the mapping's targets. Nothing here writes: the caller applies the plan.
 * An option a select property doesn't list yet is queued in `newOptions`, and `propertyDefs` (the batch's own copy
 * of each custom property's options) is what it's checked against.
 */
export function planFieldValues(
  issue: JiraIssue,
  fieldTargets: PreparedFieldTarget[] | undefined,
  resolveUser: (user: JiraUser | null | undefined) => string | null,
  propertyDefs: Map<string, { id: string; options: { value: string; label: string }[] }>,
): FieldPlan {
  const plan: FieldPlan = { core: {}, props: {}, written: 0, skipped: 0, errors: [], roundedStoryPoints: false, newOptions: [] };
  for (const target of fieldTargets ?? []) {
    const raw = (issue.fields as unknown as Record<string, unknown>)[target.jiraFieldId];
    const result = convertJiraValue(raw, target.type, { transform: target.transform, resolveUser: (user) => resolveUser(user) });
    if (result.kind === "empty") continue;
    if (result.kind === "unresolved") {
      plan.skipped++;
      continue;
    }
    if (result.kind === "error") {
      plan.skipped++;
      plan.errors.push(`field ${target.jiraName}: ${result.message}`);
      continue;
    }
    const value = result.value;
    if (target.kind === "core") {
      if (typeof value !== "number" && typeof value !== "string") continue;
      if (target.coreField === "storyPoints" && typeof value === "number") {
        const whole = Math.round(value);
        if (whole !== value) plan.roundedStoryPoints = true;
        plan.core.storyPoints = whole;
      } else if (target.coreField === "estimateSeconds" && typeof value === "number") {
        plan.core.estimateSeconds = Math.round(value);
      } else if (target.coreField === "dueDate" && typeof value === "string") {
        plan.core.dueDate = new Date(value);
      } else if (target.coreField === "startDate" && typeof value === "string") {
        plan.core.startDate = new Date(value);
      } else {
        continue;
      }
      plan.written++;
      continue;
    }
    const key = target.propertyKey!;
    plan.props[key] = value as Json;
    const def = propertyDefs.get(key);
    if (def && (target.type === "select" || target.type === "multiSelect")) {
      for (const v of Array.isArray(value) ? value : [value]) {
        if (typeof v !== "string") continue;
        if (def.options.some((o) => o.value === v) || plan.newOptions.some((n) => n.propertyKey === key && n.value === v)) continue;
        plan.newOptions.push({ propertyKey: key, value: v });
      }
    }
    plan.written++;
  }
  return plan;
}

// ── Catch-up sync: changed issues ───────────────────────────────────────────

/**
 * How far before the previous finished run's start a sync reads changes from. The run's start is the moment the
 * sync began reading JIRA, so a change made just before it can still be missing from the last sync: the margin
 * covers that, and JQL's minute resolution. A change read twice is harmless (every write compares first).
 */
export const SYNC_OVERLAP_MS = 10 * 60_000;

/** What a sync changed, as counts. The page totals add up to the run's counts. */
export interface JiraSyncCounts {
  issuesCreated: number;
  issuesUpdated: number;
  issuesUnchanged: number;
  commentsAdded: number;
  commentsUpdated: number;
  worklogsAdded: number;
  worklogsUpdated: number;
  historyEntriesRecorded: number;
  linksCreated: number;
  watchersAdded: number;
  attachmentsQueued: number;
  sprintsCreated: number;
  sprintsStarted: number;
  sprintsCompleted: number;
}

export function emptySyncCounts(): JiraSyncCounts {
  return {
    issuesCreated: 0,
    issuesUpdated: 0,
    issuesUnchanged: 0,
    commentsAdded: 0,
    commentsUpdated: 0,
    worklogsAdded: 0,
    worklogsUpdated: 0,
    historyEntriesRecorded: 0,
    linksCreated: 0,
    watchersAdded: 0,
    attachmentsQueued: 0,
    sprintsCreated: 0,
    sprintsStarted: 0,
    sprintsCompleted: 0,
  };
}

/** What a sync found but doesn't change on its own: lists for the run's notes. */
export interface JiraSyncNotes {
  newStatuses: string[];
  newTypes: string[];
  newProperties: string[];
  newPeople: string[];
  /** Issues JIRA changed that Kompast also edited since the last sync. The fields are the Kompast-side ones. */
  conflicts: { issueKey: string; fields: string[] }[];
  /** Comments, worklogs, links and attachments still in Kompast that JIRA no longer has. Left in place. */
  commentsMissingInJira: { issueKey: string; count: number }[];
  worklogsMissingInJira: { issueKey: string; count: number }[];
  linksMissingInJira: { issueKey: string; count: number }[];
  attachmentsMissingInJira: { issueKey: string; count: number }[];
  /** Imported issues whose key no longer exists in JIRA (404). Never deleted here. */
  deletedInJira: string[];
  /** Imported issues JIRA now reports under another key (moved to another project). */
  movedInJira: { key: string; newKey: string }[];
  /** Per-issue informational notes (renumbering, a skipped field), as in a full run. */
  issueNotes: { issueKey: string; note: string }[];
}

export function emptySyncNotes(): JiraSyncNotes {
  return {
    newStatuses: [],
    newTypes: [],
    newProperties: [],
    newPeople: [],
    conflicts: [],
    commentsMissingInJira: [],
    worklogsMissingInJira: [],
    linksMissingInJira: [],
    attachmentsMissingInJira: [],
    deletedInJira: [],
    movedInJira: [],
    issueNotes: [],
  };
}

export interface JiraSyncLoadContext extends JiraLoadContext {
  /** When the previous finished run started reading JIRA (jira_migration.lastSyncedAt). Changes since then are the sync's. */
  previousSyncedAt: Date;
}

export interface JiraSyncBatchResult {
  counts: JiraSyncCounts;
  notes: JiraSyncNotes;
  errors: JiraLoadReport["errors"];
  deferredParents: DeferredParent[];
  deferredLinks: DeferredLink[];
}

/** The Kompast field a changelog item changes, in the vocabulary the history rows and the conflict notes use. Null when it isn't migrated. */
function jiraFieldOfItem(item: JiraChangelogItem, o: { fieldTargets: PreparedFieldTarget[] | undefined; storyPointsFieldId: string | undefined }): string | null {
  const target = o.fieldTargets?.find((t) => (item.fieldId ? t.jiraFieldId === item.fieldId : t.jiraName.toLowerCase() === item.field.toLowerCase()));
  if (target) return target.kind === "core" ? (target.coreField ?? null) : `customFields.${target.propertyKey}`;
  const name = item.field.toLowerCase();
  switch (name) {
    case "status":
      return "status";
    case "summary":
      return "title";
    case "description":
      return "description";
    case "issuetype":
      return "typeId";
    case "priority":
      return "priority";
    case "assignee":
      return "assigneeId";
    case "reporter":
      return "reporterId";
    case "labels":
      return "labels";
    case "duedate":
      return "dueDate";
    case "sprint":
      return "sprint";
    case "resolution":
    case "resolutiondate":
      return "resolvedAt";
    case "timeoriginalestimate":
    case "original estimate":
      return "estimateSeconds";
    default:
      break;
  }
  if (!o.fieldTargets && ((!!o.storyPointsFieldId && item.fieldId === o.storyPointsFieldId) || name === "story point estimate" || name === "story points")) return "storyPoints";
  return null;
}

/** A history row's identity for dedupe: the same field, time and new value means the same JIRA change. */
function historyKeyOf(field: string, at: Date, toValue: string | null | undefined): string {
  return `${field}|${at.getTime()}|${toValue ?? ""}`;
}

/**
 * JSON with every object's keys sorted. JSONB returns keys in its own order, so two equal values written and read back
 * don't stringify alike unless both sides are sorted: every comparison a sync makes goes through this.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v,
  );
}

/** A body (or any JSON) for comparison: an empty value is one value, and a mention's target (resolved later) is ignored. */
function comparableBody(value: unknown): string {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return "null";
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== "object") return node;
    const n = node as Record<string, unknown>;
    if (n.type === "issueMention") return { type: "issueMention" };
    return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, strip(v)]));
  };
  return stableJson(strip(value));
}

/**
 * Points each inline reference to a JIRA attachment at what the attachment became: its stored copy, or a link to JIRA
 * when it isn't going to be copied. A pending file is left alone (the attachments phase rewrites it when it's stored).
 */
async function settleInlineAttachments(sp: Tx, organizationId: string, issueKey: string, value: unknown): Promise<unknown> {
  let out = value;
  for (const jiraId of collectInlineAttachmentIds(value)) {
    const ref = await resolveExternalRef(sp, organizationId, "jira", `${issueKey}/${jiraId}`);
    if (!ref) continue;
    const [row] = await sp
      .select({ id: schema.issueAttachment.id, status: schema.issueAttachment.status, fileName: schema.issueAttachment.fileName, sourceUrl: schema.issueAttachment.sourceUrl })
      .from(schema.issueAttachment)
      .where(eq(schema.issueAttachment.id, ref.entityId));
    if (!row) continue;
    if (row.status === "stored") out = rewriteAttachmentUrls(out, jiraId, `/api/issue-attachments/${row.id}`).value;
    else if (row.status === "not_migrated" || row.status === "failed") {
      out = linkUnavailableAttachment(out, jiraId, { fileName: row.fileName, sourceUrl: row.sourceUrl ?? "" }).value;
    }
  }
  return out;
}

/** What the sync needs to read a JIRA issue against Kompast: the mapping, the lookups, and the converters the loader uses. */
interface SyncEnv {
  ctx: JiraSyncLoadContext;
  prepared: PreparedJiraImport;
  fieldTargets: PreparedFieldTarget[] | undefined;
  resolveUser: (user: JiraUser | null | undefined) => string | null;
  formerOf: (user: JiraUser | null | undefined) => string | null;
  userByAccount: Map<string, JiraUser>;
  typeIdOf: (name: string) => string | undefined;
  statusIdOf: (name: string) => string | undefined;
  priorityLevels: PriorityLevelRef[];
  priorityMapping: { jiraName: string; kompastKey: string }[];
  sprintByJiraId: Map<number, LoadedSprint & { order: number }>;
  historyChangeOf: ReturnType<typeof historyMapperOf>["change"];
  blocksOf: ReturnType<typeof convertBodyOf>;
  propertyDefs: Map<string, { id: string; options: { value: string; label: string }[] }>;
  dirtyPropertyKeys: Set<string>;
  inlineIdsByKey: Map<string, Set<string>>;
  jiraBase: string | undefined;
  kompastProject: { projectKey: string; teamId: string };
  jiraProjectKey: string;
  /** JIRA's story-points field id, the 3a rule's source when the mapping has no fields list. */
  storyPointsFieldId: string | undefined;
}

/** One issue's outcome, kept apart from the batch until its savepoint has committed. */
interface SyncIssueOutcome {
  counts: JiraSyncCounts;
  notes: JiraSyncNotes;
  deferredParents: DeferredParent[];
  deferredLinks: DeferredLink[];
}

/**
 * Brings one batch of JIRA's changed issues into Kompast. An issue Kompast doesn't have yet goes through the full
 * load's path (loadJiraIssueBatch), so it's created exactly as a full run creates it. An issue it already has is
 * updated in place (syncExistingIssue). Each issue has its own savepoint, so one failing issue rolls back only itself.
 * Deferred parents and link targets are returned for finalizeJiraImport, as in a full run.
 */
export async function syncJiraIssueBatch(tx: Tx, issues: JiraIssue[], ctx: JiraSyncLoadContext, prepared: PreparedJiraImport): Promise<JiraSyncBatchResult> {
  const counts = emptySyncCounts();
  const notes = emptySyncNotes();
  const errors: JiraLoadReport["errors"] = [];
  const deferredParents: DeferredParent[] = [];
  const deferredLinks: DeferredLink[] = [];

  const existingIssueIdByKey = new Map<string, string>();
  const fresh: JiraIssue[] = [];
  for (const issue of issues) {
    const ref = await resolveExternalRef(tx, ctx.organizationId, "jira", issue.key);
    if (ref) existingIssueIdByKey.set(issue.key, ref.entityId);
    else fresh.push(issue);
  }

  if (fresh.length > 0) {
    const batch = await loadJiraIssueBatch(tx, fresh, ctx, prepared);
    counts.issuesCreated += batch.counts.issuesCreated;
    counts.commentsAdded += batch.counts.commentsCreated;
    counts.worklogsAdded += batch.counts.worklogsCreated;
    counts.linksCreated += batch.counts.linksCreated;
    counts.watchersAdded += batch.counts.watchersAdded;
    counts.attachmentsQueued += batch.counts.attachmentsQueued;
    counts.historyEntriesRecorded += batch.counts.historyEntriesRecorded + batch.counts.historicalTransitionsRecorded;
    errors.push(...batch.errors);
    notes.issueNotes.push(...batch.notes);
    deferredParents.push(...batch.deferredParents);
    deferredLinks.push(...batch.deferredLinks);
  }

  const env = await syncEnvOf(tx, ctx, prepared);
  for (const issue of issues) {
    const issueId = existingIssueIdByKey.get(issue.key);
    if (!issueId) continue;
    try {
      const outcome = await tx.transaction((sp) => syncExistingIssue(sp, issueId, issue, env));
      for (const k of Object.keys(counts) as (keyof JiraSyncCounts)[]) counts[k] += outcome.counts[k];
      notes.conflicts.push(...outcome.notes.conflicts);
      notes.commentsMissingInJira.push(...outcome.notes.commentsMissingInJira);
      notes.worklogsMissingInJira.push(...outcome.notes.worklogsMissingInJira);
      notes.linksMissingInJira.push(...outcome.notes.linksMissingInJira);
      notes.attachmentsMissingInJira.push(...outcome.notes.attachmentsMissingInJira);
      deferredParents.push(...outcome.deferredParents);
      deferredLinks.push(...outcome.deferredLinks);
    } catch (err) {
      errors.push({ issueKey: issue.key, error: errorMessage(err) });
    }
  }

  // Options a select property gained in this batch, written once.
  for (const key of env.dirtyPropertyKeys) {
    const def = env.propertyDefs.get(key)!;
    await tx.update(schema.issuePropertyDefinition).set({ options: def.options as unknown as Json, updatedAt: new Date() }).where(eq(schema.issuePropertyDefinition.id, def.id));
  }

  return { counts, notes, errors, deferredParents, deferredLinks };
}

/** Builds the lookups one sync batch reads with: the same closures loadJiraIssueBatch builds, without its counters. */
async function syncEnvOf(tx: Tx, ctx: JiraSyncLoadContext, prepared: PreparedJiraImport): Promise<SyncEnv> {
  const fieldTargets = prepared.fieldTargets;
  const formerIds = prepared.formerUserIdByAccount ?? {};
  const formerOf = (user: JiraUser | null | undefined): string | null =>
    user && Object.prototype.hasOwnProperty.call(formerIds, user.accountId) ? formerIds[user.accountId]! : null;
  const resolveMapped = ctx.resolveUserId ?? (() => null);
  const resolveUser = (user: JiraUser | null | undefined): string | null => (user ? (resolveMapped(user) ?? formerOf(user)) : null);

  const userByAccount = new Map<string, JiraUser>();
  const priorityLevels = prepared.priorityLevels ?? (await listPriorityLevels(tx, ctx.projectId)).map((l) => ({ key: l.key, name: l.name }));
  const priorityMapping = prepared.priorityMapping ?? [];
  const [projectRow] = await tx.select({ key: schema.project.key, teamId: schema.project.teamId }).from(schema.project).where(eq(schema.project.id, ctx.projectId));
  const kompastProject = { projectKey: projectRow?.key ?? "", teamId: projectRow?.teamId ?? "" };
  const jiraProjectKey = ctx.jiraProjectKey ?? "";
  const jiraBase = ctx.jiraBaseUrl?.replace(/\/+$/, "");
  const sprintByJiraId = new Map<number, LoadedSprint & { order: number }>(
    prepared.sprints.map((p) => [p.jiraSprintId, { ...p, startAt: p.startAt ? new Date(p.startAt) : undefined, endAt: p.endAt ? new Date(p.endAt) : undefined }]),
  );
  const propertyDefs = new Map<string, { id: string; options: { value: string; label: string }[] }>();
  if (fieldTargets?.some((t) => t.kind === "property")) {
    const rows = await tx.select().from(schema.issuePropertyDefinition).where(eq(schema.issuePropertyDefinition.projectId, ctx.projectId));
    for (const row of rows) {
      if (!row.isCore) propertyDefs.set(row.key, { id: row.id, options: ((row.options as unknown as { value: string; label: string }[] | null) ?? []).slice() });
    }
  }
  const inlineIdsByKey = new Map<string, Set<string>>();
  const historyChangeOf = historyMapperOf({ fieldTargets, storyPointsFieldId: ctx.storyPointsFieldId, priorityLevels, priorityMapping, resolveUser, userByAccount, sprintByJiraId }).change;
  const issueKeyNumberFor = (jiraKey: string): number | null => {
    const match = /^(.+)-(\d+)$/.exec(jiraKey);
    return match && jiraProjectKey && match[1] === jiraProjectKey ? Number(match[2]) : null;
  };
  const blocksOf = convertBodyOf({
    resolveUser,
    userByAccount,
    jiraBaseUrl: ctx.jiraBaseUrl,
    jiraProjectKey,
    kompastProject,
    issueKeyNumberFor,
    counts: emptyCounts(),
    inlineIdsByKey,
  });
  return {
    ctx,
    prepared,
    fieldTargets,
    resolveUser,
    formerOf,
    userByAccount,
    typeIdOf: (name) => idOf(prepared.typeIdByName, name.toLowerCase()),
    statusIdOf: (name) => idOf(prepared.statusIdByName, name.toLowerCase()),
    priorityLevels,
    priorityMapping,
    sprintByJiraId,
    historyChangeOf,
    blocksOf,
    propertyDefs,
    dirtyPropertyKeys: new Set<string>(),
    inlineIdsByKey,
    jiraBase,
    kompastProject,
    jiraProjectKey,
    storyPointsFieldId: ctx.storyPointsFieldId,
  };
}

/** The JIRA sprint an issue belongs to now, as the full load decides it (see loadJiraIssueBatch's pass 2b). */
function currentSprintIdOf(issue: JiraIssue, sprintByJiraId: SyncEnv["sprintByJiraId"]): string | null {
  const currentId = currentJiraSprintIdOf(issue, sprintRanksOf(sprintByJiraId));
  return currentId === null ? null : (sprintByJiraId.get(currentId)?.kompastSprintId ?? null);
}

/** The loader's sprint ranks for the current-sprint rule: each imported sprint's place in the plan order, and whether Kompast holds it open. */
function sprintRanksOf(sprintByJiraId: ReadonlyMap<number, LoadedSprint & { order: number }>): Map<number, SprintRank> {
  const ranks = new Map<number, SprintRank>();
  for (const [jiraId, p] of sprintByJiraId) {
    if (p.kompastSprintId) ranks.set(jiraId, { order: p.order, open: p.state !== "closed" });
  }
  return ranks;
}

/** The newest changelog time of a Sprint change, or null when the changelog has none. */
function latestSprintChangeAt(issue: JiraIssue): Date | null {
  let latest: Date | null = null;
  for (const h of issue.changelog?.histories ?? []) {
    if (!h.items.some((i) => i.field.toLowerCase() === "sprint")) continue;
    const at = new Date(h.created);
    if (!Number.isNaN(at.getTime()) && (!latest || at > latest)) latest = at;
  }
  return latest;
}

function emptyIssueOutcome(): SyncIssueOutcome {
  return { counts: emptySyncCounts(), notes: emptySyncNotes(), deferredParents: [], deferredLinks: [] };
}

/**
 * Updates one issue Kompast already has, to match JIRA. Fields JIRA changed since the last sync take JIRA's value;
 * a field only Kompast changed is left alone. Sprint and parent follow JIRA as they are. Comments, worklogs, links,
 * watchers and attachments are added, updated (where JIRA's copy is newer) or reported when JIRA no longer has them.
 * The changelog becomes history rows, deduped against the rows an earlier run wrote, so no change is recorded twice.
 * Nothing is written when nothing differs: an identical second sync reports the issue as unchanged.
 */
async function syncExistingIssue(sp: Tx, issueId: string, issue: JiraIssue, env: SyncEnv): Promise<SyncIssueOutcome> {
  const ctx = env.ctx;
  const key = issue.key;
  const out = emptyIssueOutcome();
  const plan = env.fieldTargets ? planFieldValues(issue, env.fieldTargets, env.resolveUser, env.propertyDefs) : null;
  const attachments = issue.fields.attachment ?? [];
  const actorId = ctx.actorUserId;
  const sinceMs = ctx.previousSyncedAt.getTime() - SYNC_OVERLAP_MS;
  let changed = false;

  const [cur] = await sp.select().from(schema.issue).where(eq(schema.issue.id, issueId));
  if (!cur) throw new Error(`${key} is linked to Kompast, but its issue row is gone`);

  // The fields JIRA changed in the window, and the Kompast-side edits made since the previous run.
  const jiraChanged = new Set<string>();
  for (const h of issue.changelog?.histories ?? []) {
    if (new Date(h.created).getTime() < sinceMs) continue;
    for (const item of h.items) {
      const field = jiraFieldOfItem(item, env);
      if (field) jiraChanged.add(field);
    }
  }
  const kompastEdits = await sp
    .select({ field: schema.issueHistory.field })
    .from(schema.issueHistory)
    .where(and(eq(schema.issueHistory.issueId, issueId), sql`${schema.issueHistory.origin} <> 'import'`, sql`${schema.issueHistory.createdAt} > ${ctx.previousSyncedAt.toISOString()}::timestamptz`));
  const kompastFields = [...new Set(kompastEdits.map((r) => r.field))].sort();
  if (kompastFields.length > 0 && jiraChanged.size > 0) out.notes.conflicts.push({ issueKey: key, fields: kompastFields });

  // ── Scalar fields and the description: JIRA's value, for the fields JIRA changed, when it differs.
  const patch: Partial<UpdateIssueInput> & { customFields?: Json; descriptionJson?: Json } = {};
  const direct: Partial<typeof schema.issue.$inferInsert> = {};
  const sameMs = (a: Date | null | undefined, b: Date | undefined) => (a ? a.getTime() : null) === (b ? b.getTime() : null);

  if (jiraChanged.has("title") && issue.fields.summary !== cur.title) patch.title = issue.fields.summary;
  if (jiraChanged.has("typeId")) {
    const typeId = env.typeIdOf(issue.fields.issuetype.name);
    if (typeId && typeId !== cur.typeId) patch.typeId = typeId;
  }
  if (jiraChanged.has("status")) {
    const statusId = env.statusIdOf(issue.fields.status.name);
    if (statusId && statusId !== cur.statusId) direct.statusId = statusId;
  }
  if (jiraChanged.has("priority")) {
    const priority = resolvePriorityKey(issue.fields.priority?.name, env.priorityLevels, env.priorityMapping);
    if (priority !== cur.priority) patch.priority = priority;
  }
  if (jiraChanged.has("assigneeId")) {
    const assigneeId = env.resolveUser(issue.fields.assignee) ?? null;
    if (assigneeId !== cur.assigneeId) patch.assigneeId = assigneeId;
  }
  if (jiraChanged.has("reporterId")) {
    const reporterId = env.resolveUser(issue.fields.reporter) ?? ctx.actorUserId;
    if (reporterId !== cur.reporterId) direct.reporterId = reporterId;
  }
  if (jiraChanged.has("labels")) {
    const labels = issue.fields.labels ?? [];
    if ([...labels].sort().join(" ") !== [...cur.labels].sort().join(" ")) patch.labels = labels;
  }
  if (jiraChanged.has("description")) {
    const blocks = env.blocksOf(issue.fields.description, attachments, key);
    const settled = (await settleInlineAttachments(sp, ctx.organizationId, key, blocks)) as unknown[];
    const next = settled.length > 0 ? (settled as Json) : null;
    if (comparableBody(next) !== comparableBody(cur.descriptionJson)) patch.descriptionJson = next;
  }
  if (jiraChanged.has("dueDate")) {
    const dueDate = plan?.core.dueDate ?? (issue.fields.duedate ? new Date(issue.fields.duedate) : null);
    if (!sameMs(cur.dueDate, dueDate ?? undefined) || (!dueDate && cur.dueDate)) patch.dueDate = dueDate ?? null;
  }
  if (jiraChanged.has("startDate")) {
    const startDate = plan?.core.startDate ?? null;
    if (!sameMs(cur.startDate, startDate ?? undefined) || (!startDate && cur.startDate)) patch.startDate = startDate;
  }
  if (jiraChanged.has("estimateSeconds")) {
    const estimate = plan?.core.estimateSeconds ?? issue.fields.timeoriginalestimate ?? null;
    if (estimate !== cur.estimateSeconds) patch.estimateSeconds = estimate;
  }
  if (jiraChanged.has("storyPoints")) {
    const points = plan ? (plan.core.storyPoints ?? null) : (storyPointsOf(issue, ctx.storyPointsFieldId) ?? null);
    if (points !== cur.storyPoints) patch.storyPoints = points;
  }
  if (jiraChanged.has("resolvedAt")) {
    const resolvedAt = toDate(issue.fields.resolutiondate ?? undefined) ?? null;
    if (!sameMs(cur.resolvedAt, resolvedAt ?? undefined) || (!resolvedAt && cur.resolvedAt)) direct.resolvedAt = resolvedAt;
  }

  // ── Custom properties the mapping writes, when JIRA changed them; then the JIRA block, which JIRA owns.
  const custom: Record<string, Json> = { ...((cur.customFields as Record<string, Json> | null) ?? {}) };
  let customChanged = false;
  for (const target of env.fieldTargets ?? []) {
    if (target.kind !== "property" || !target.propertyKey) continue;
    if (!jiraChanged.has(`customFields.${target.propertyKey}`)) continue;
    const value = plan?.props[target.propertyKey];
    const previous = custom[target.propertyKey];
    if (value === undefined) {
      if (previous !== undefined) {
        delete custom[target.propertyKey];
        customChanged = true;
      }
    } else if (stableJson(previous) !== stableJson(value)) {
      custom[target.propertyKey] = value;
      customChanged = true;
    }
  }
  for (const n of plan?.newOptions ?? []) {
    const def = env.propertyDefs.get(n.propertyKey);
    if (!def || def.options.some((o) => o.value === n.value)) continue;
    def.options.push({ value: n.value, label: n.value });
    env.dirtyPropertyKeys.add(n.propertyKey);
  }
  const resolution = issue.fields.resolution?.name;
  const jiraBlock = {
    originalKey: key,
    fixVersions: (issue.fields.fixVersions ?? []).map((v) => v.name),
    components: (issue.fields.components ?? []).map((c) => c.name),
    ...(resolution ? { resolution } : {}),
  };
  if (stableJson(custom.jira ?? null) !== stableJson(jiraBlock)) {
    custom.jira = jiraBlock as unknown as Json;
    customChanged = true;
  }
  if (customChanged) patch.customFields = custom as unknown as Json;

  // ── Parent: set or cleared to match JIRA. A parent not imported yet is deferred, as in the full load.
  const historyActorId = env.resolveUser(issue.fields.reporter) ?? ctx.actorUserId;
  if (!issue.fields.parent?.key) {
    if (cur.parentId !== null) patch.parentId = null;
  } else {
    const parentKey = issue.fields.parent.key;
    const parentId = (await resolveExternalRef(sp, ctx.organizationId, "jira", parentKey))?.entityId ?? null;
    if (parentId) {
      if (parentId !== cur.parentId) patch.parentId = parentId;
    } else {
      out.deferredParents.push({ childKey: key, parentKey, updatedAt: issue.fields.updated, createdAt: issue.fields.created, historyActorId });
    }
  }

  if (Object.keys(patch).length > 0) {
    await updateIssue(sp, issueId, { ...patch, actorId, origin: "import", recordHistory: false } as UpdateIssueInput);
    changed = true;
  }
  if (Object.keys(direct).length > 0) {
    await sp.update(schema.issue).set(direct).where(eq(schema.issue.id, issueId));
    // Today direct never carries title/descriptionJson (those go through updateIssue above, which enqueues itself); the guard keeps a future direct field from silently skipping reindex.
    if ("title" in direct || "descriptionJson" in direct) {
      await enqueueReindex(sp, { organizationId: ctx.organizationId, entityType: "issue", entityId: issueId });
    }
    changed = true;
  }

  // ── Sprint: JIRA's current sprint, as the full load decides it. Moved when it differs.
  const sprintId = currentSprintIdOf(issue, env.sprintByJiraId);
  if (sprintId !== cur.sprintId) {
    await moveImportedIssueSprint(sp, { issueId, boardId: ctx.boardId, sprintId, movedAt: latestSprintChangeAt(issue) ?? new Date() });
    changed = true;
  }

  // ── Comments: new ones added; an existing one replaced when JIRA's copy is newer; ones JIRA lost are reported.
  const jiraCommentIds = new Set<string>();
  for (const c of issue.fields.comment?.comments ?? []) {
    jiraCommentIds.add(c.id);
    const refKey = `${key}/${c.id}`;
    const ref = await resolveExternalRef(sp, ctx.organizationId, "jira", refKey);
    const jiraUpdated = toDate(c.updated);
    if (!ref) {
      const body = await settleInlineAttachments(sp, ctx.organizationId, key, env.blocksOf(c.body, attachments, key));
      const { commentId } = await addComment(sp, {
        issueId,
        authorId: env.resolveUser(c.author) ?? actorId,
        bodyJson: body as Json,
        origin: "import",
        createdAt: new Date(c.created),
      });
      if (jiraUpdated) await sp.update(schema.issueComment).set({ updatedAt: jiraUpdated }).where(eq(schema.issueComment.id, commentId));
      await upsertExternalRef(sp, {
        organizationId: ctx.organizationId,
        source: "jira",
        sourceId: refKey,
        sourceUrl: env.jiraBase ? `${env.jiraBase}/browse/${key}?focusedCommentId=${c.id}` : undefined,
        entityType: "comment",
        entityId: commentId,
        importRunId: ctx.importRunId,
      });
      out.counts.commentsAdded++;
      changed = true;
      continue;
    }
    const [row] = await sp.select({ updatedAt: schema.issueComment.updatedAt }).from(schema.issueComment).where(eq(schema.issueComment.id, ref.entityId));
    if (row && jiraUpdated && row.updatedAt.getTime() < jiraUpdated.getTime()) {
      const body = await settleInlineAttachments(sp, ctx.organizationId, key, env.blocksOf(c.body, attachments, key));
      await sp.update(schema.issueComment).set({ bodyJson: body as Json, updatedAt: jiraUpdated }).where(eq(schema.issueComment.id, ref.entityId));
      await enqueueReindex(sp, { organizationId: ctx.organizationId, entityType: "comment", entityId: ref.entityId });
      out.counts.commentsUpdated++;
      changed = true;
    }
  }
  const knownComments = await sp
    .select({ sourceId: schema.externalRef.sourceId })
    .from(schema.externalRef)
    .where(and(eq(schema.externalRef.organizationId, ctx.organizationId), eq(schema.externalRef.source, "jira"), eq(schema.externalRef.entityType, "comment"), sql`${schema.externalRef.sourceId} like ${`${key}/%`}`));
  const commentsGone = knownComments.filter((r) => !jiraCommentIds.has(r.sourceId.slice(key.length + 1))).length;
  if (commentsGone > 0) out.notes.commentsMissingInJira.push({ issueKey: key, count: commentsGone });

  // ── Worklogs: new ones added; a changed one updated, with the issue's spent total moved by the difference.
  const jiraWorklogIds = new Set<string>();
  for (const w of issue.fields.worklog?.worklogs ?? []) {
    jiraWorklogIds.add(w.id);
    const refKey = `${key}/${w.id}`;
    const ref = await resolveExternalRef(sp, ctx.organizationId, "jira", refKey);
    const note = w.comment ? adfToPlainText(w.comment) : undefined;
    if (!ref) {
      const { worklogId } = await logWork(sp, {
        issueId,
        userId: env.resolveUser(w.author) ?? actorId,
        seconds: w.timeSpentSeconds,
        note,
        loggedAt: new Date(w.started),
      });
      await upsertExternalRef(sp, { organizationId: ctx.organizationId, source: "jira", sourceId: refKey, entityType: "worklog", entityId: worklogId, importRunId: ctx.importRunId });
      out.counts.worklogsAdded++;
      changed = true;
      continue;
    }
    const [row] = await sp.select().from(schema.worklog).where(eq(schema.worklog.id, ref.entityId));
    if (!row) continue;
    const started = new Date(w.started);
    const same = row.seconds === w.timeSpentSeconds && row.loggedAt.getTime() === started.getTime() && (row.note ?? null) === (note ?? null);
    if (same) continue;
    await sp.update(schema.worklog).set({ seconds: w.timeSpentSeconds, note: note ?? null, loggedAt: started }).where(eq(schema.worklog.id, row.id));
    await sp
      .update(schema.issue)
      .set({ spentSeconds: sql`${schema.issue.spentSeconds} + ${w.timeSpentSeconds - row.seconds}` })
      .where(eq(schema.issue.id, issueId));
    out.counts.worklogsUpdated++;
    changed = true;
  }
  const knownWorklogs = await sp
    .select({ sourceId: schema.externalRef.sourceId })
    .from(schema.externalRef)
    .where(and(eq(schema.externalRef.organizationId, ctx.organizationId), eq(schema.externalRef.source, "jira"), eq(schema.externalRef.entityType, "worklog"), sql`${schema.externalRef.sourceId} like ${`${key}/%`}`));
  const worklogsGone = knownWorklogs.filter((r) => !jiraWorklogIds.has(r.sourceId.slice(key.length + 1))).length;
  if (worklogsGone > 0) out.notes.worklogsMissingInJira.push({ issueKey: key, count: worklogsGone });

  // ── Links: the outward links JIRA has, added where missing. Links JIRA no longer has are reported, not removed.
  const jiraOutward = new Set<string>();
  for (const link of issue.fields.issuelinks ?? []) {
    if (!link.outwardIssue) continue;
    const type = mapLinkType(link.type.name);
    jiraOutward.add(`${link.outwardIssue.key}|${type}`);
    const toIssueId = (await resolveExternalRef(sp, ctx.organizationId, "jira", link.outwardIssue.key))?.entityId ?? null;
    if (!toIssueId) {
      out.deferredLinks.push({ fromKey: key, toKey: link.outwardIssue.key, type });
      continue;
    }
    const [existingLink] = await sp
      .select({ id: schema.issueLink.id })
      .from(schema.issueLink)
      .where(and(eq(schema.issueLink.fromIssueId, issueId), eq(schema.issueLink.toIssueId, toIssueId), eq(schema.issueLink.type, type)));
    if (!existingLink) {
      await linkIssues(sp, { fromIssueId: issueId, toIssueId, type });
      out.counts.linksCreated++;
      changed = true;
    }
  }
  const outgoing = await sp
    .select({ toIssueId: schema.issueLink.toIssueId, type: schema.issueLink.type })
    .from(schema.issueLink)
    .where(eq(schema.issueLink.fromIssueId, issueId));
  let linksGone = 0;
  for (const link of outgoing) {
    const [target] = await sp
      .select({ sourceId: schema.externalRef.sourceId })
      .from(schema.externalRef)
      .where(and(eq(schema.externalRef.organizationId, ctx.organizationId), eq(schema.externalRef.source, "jira"), eq(schema.externalRef.entityType, "issue"), eq(schema.externalRef.entityId, link.toIssueId)));
    if (target && !jiraOutward.has(`${target.sourceId}|${link.type}`)) linksGone++;
  }
  if (linksGone > 0) out.notes.linksMissingInJira.push({ issueKey: key, count: linksGone });

  // ── Attachments: new ones get placeholders (the attachments phase copies them). Ones JIRA lost are reported.
  const inlineIds = env.inlineIdsByKey.get(key) ?? new Set<string>();
  for (const att of attachments) {
    if (await resolveExternalRef(sp, ctx.organizationId, "jira", `${key}/${att.id}`)) continue;
    const outcome = await writeAttachmentPlaceholder(sp, {
      ctx,
      issueId,
      issueKey: key,
      issueCreated: issue.fields.created,
      att,
      inline: inlineIds.has(att.id),
      maxBytes: ctx.migrationAttachments?.maxBytes ?? null,
      resolveUser: env.resolveUser,
      jiraBase: env.jiraBase,
    });
    if (outcome === "pending") out.counts.attachmentsQueued++;
    changed = true;
  }
  const jiraAttachmentIds = new Set(attachments.map((a) => a.id));
  const knownAttachments = await sp
    .select({ sourceId: schema.externalRef.sourceId })
    .from(schema.externalRef)
    .where(and(eq(schema.externalRef.organizationId, ctx.organizationId), eq(schema.externalRef.source, "jira"), eq(schema.externalRef.entityType, "attachment"), sql`${schema.externalRef.sourceId} like ${`${key}/%`}`));
  const attachmentsGone = knownAttachments.filter((r) => !jiraAttachmentIds.has(r.sourceId.slice(key.length + 1))).length;
  if (attachmentsGone > 0) out.notes.attachmentsMissingInJira.push({ issueKey: key, count: attachmentsGone });

  // ── Watchers: mapped watchers added. Nobody is removed.
  const watching = new Set((await listWatchers(sp, issueId)).map((w) => w.userId));
  for (const w of issue.watchersList ?? []) {
    const userId = env.resolveUser(w);
    if (!userId || userId === env.formerOf(w) || watching.has(userId)) continue;
    await setWatching(sp, { issueId, userId, watching: true });
    watching.add(userId);
    out.counts.watchersAdded++;
    changed = true;
  }

  // ── Changelog: each entry becomes a history row once. The rows an earlier run wrote are the dedupe set.
  const seen = new Set(
    (await sp.select({ field: schema.issueHistory.field, createdAt: schema.issueHistory.createdAt, toValue: schema.issueHistory.toValue }).from(schema.issueHistory).where(and(eq(schema.issueHistory.issueId, issueId), sql`${schema.issueHistory.origin} = 'import'`)))
      .map((r) => historyKeyOf(r.field, r.createdAt, r.toValue)),
  );
  const histories = [...(issue.changelog?.histories ?? [])].sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());
  for (const h of histories) {
    const createdAt = new Date(h.created);
    const historyActor = env.resolveUser(h.author) ?? actorId;
    for (const item of h.items) {
      if (item.field === "status") {
        const toStatusId = item.toString ? env.statusIdOf(item.toString) : undefined;
        if (!toStatusId) continue;
        const fromStatusId = item.fromString ? (env.statusIdOf(item.fromString) ?? null) : null;
        const k = historyKeyOf("status", createdAt, toStatusId);
        if (seen.has(k)) continue;
        await recordHistoricalStatusChange(sp, { issueId, actorId: historyActor, fromStatusId, toStatusId, createdAt });
        seen.add(k);
        out.counts.historyEntriesRecorded++;
        changed = true;
        continue;
      }
      const change = env.historyChangeOf(item);
      if (!change) continue;
      const k = historyKeyOf(change.field, createdAt, change.toValue);
      if (seen.has(k)) continue;
      await recordHistoricalFieldChange(sp, { issueId, actorId: historyActor, field: change.field, fromValue: change.fromValue, toValue: change.toValue, createdAt });
      seen.add(k);
      out.counts.historyEntriesRecorded++;
      changed = true;
    }
  }

  // Last: JIRA's update time, so the issue reads as JIRA has it. An unchanged issue keeps its own.
  if (changed) {
    await sp
      .update(schema.issue)
      .set({ updatedAt: toDate(issue.fields.updated) ?? new Date() })
      .where(eq(schema.issue.id, issueId));
    out.counts.issuesUpdated = 1;
  } else {
    out.counts.issuesUnchanged = 1;
  }
  return out;
}


// ── Finalize (once, after the last batch) ───────────────────────────────────

/**
 * Resolves what the batches deferred (parent links and link targets, now that
 * every batch's issues exist), points the issue mentions at their issues, then
 * records the start/complete snapshot for each sprint this import created. A
 * sprint that already has that snapshot kind is skipped, so a re-run doesn't add
 * a second one.
 */
export async function finalizeJiraImport(
  tx: Tx,
  ctx: JiraLoadContext,
  prepared: PreparedJiraImport,
  deferred: { deferredParents: DeferredParent[]; deferredLinks: DeferredLink[] },
): Promise<JiraFinalizeResult> {
  const counts = { parentLinksResolved: 0, linksCreated: 0, issueMentionsResolved: 0, issueMentionsUnresolved: 0 };
  const errors: JiraLoadReport["errors"] = [];
  const resolve = async (jiraKey: string) => (await resolveExternalRef(tx, ctx.organizationId, "jira", jiraKey))?.entityId ?? null;

  for (const d of deferred.deferredParents) {
    const childId = await resolve(d.childKey);
    const parentId = await resolve(d.parentKey);
    if (!childId || !parentId) continue; // child errored, or parent isn't part of any import — nothing to link
    try {
      await tx.transaction(async (sp) => {
        await updateIssue(sp, childId, {
          parentId,
          actorId: ctx.actorUserId,
          origin: "import",
          historyAt: toDate(d.createdAt),
          historyActorId: d.historyActorId,
        });
        // updateIssue stamps updated_at with now. Put back the JIRA value this issue was loaded with.
        const updatedAt = toDate(d.updatedAt);
        if (updatedAt) await sp.update(schema.issue).set({ updatedAt }).where(eq(schema.issue.id, childId));
      });
      counts.parentLinksResolved++;
    } catch (err) {
      errors.push({ issueKey: d.childKey, error: `parent link: ${errorMessage(err)}` });
    }
  }

  for (const d of deferred.deferredLinks) {
    const fromId = await resolve(d.fromKey);
    const toId = await resolve(d.toKey);
    if (!fromId || !toId) continue; // a link to an issue outside this import — skipped, as before
    try {
      await tx.transaction((sp) => linkIssues(sp, { fromIssueId: fromId, toIssueId: toId, type: d.type }));
      counts.linksCreated++;
    } catch (err) {
      errors.push({ issueKey: d.fromKey, error: `link: ${errorMessage(err)}` });
    }
  }

  const mentions = await resolveIssueMentions(tx, ctx);
  counts.issueMentionsResolved += mentions.resolved;
  counts.issueMentionsUnresolved += mentions.unresolved;

  await recordCreatedSprintSnapshots(tx, prepared);

  return { counts, errors };
}

/**
 * The start or complete snapshot of each sprint a prepare step created (action "create"). A sprint that already has
 * that snapshot kind is skipped, so calling this twice for one sprint records one snapshot.
 */
export async function recordCreatedSprintSnapshots(tx: Tx, prepared: PreparedJiraImport): Promise<void> {
  for (const p of prepared.sprints) {
    if (p.action !== "create" || !p.kompastSprintId) continue;
    const kind = p.state === "closed" ? "complete" : p.state === "active" ? "start" : null;
    if (!kind) continue;
    const [existing] = await tx
      .select({ id: schema.sprintSnapshot.id })
      .from(schema.sprintSnapshot)
      .where(and(eq(schema.sprintSnapshot.sprintId, p.kompastSprintId), eq(schema.sprintSnapshot.kind, kind)))
      .limit(1);
    if (existing) continue;
    const takenAt = kind === "complete" ? p.endAt : p.startAt;
    await recordImportedSprintSnapshot(tx, p.kompastSprintId, kind, takenAt ? new Date(takenAt) : undefined);
  }
}

/**
 * Brings the sprints a sync already imported in line with JIRA: name, goal and dates, and the state. A sprint JIRA
 * closed (Kompast active) is completed first, so the board's one active slot is free for a sprint JIRA started
 * (Kompast future). Issues are not moved here: the issue pages place them. Sprints created in this sync are
 * handled by prepareJiraImport, and the states it gives them already match JIRA.
 */
export async function syncImportedSprintStates(tx: Tx, ctx: { organizationId: string }, boardId: string, sprints: JiraSprint[]): Promise<{ sprintsStarted: number; sprintsCompleted: number }> {
  const rows = new Map<number, { sprintId: string; name: string; goal: string | null; startAt: Date | null; endAt: Date | null; state: "future" | "active" | "closed" }>();
  for (const s of sprints) {
    const ref = await resolveExternalRef(tx, ctx.organizationId, "jira", sprintRefId(s.id));
    if (!ref) continue;
    const [row] = await tx.select().from(schema.sprint).where(eq(schema.sprint.id, ref.entityId));
    if (row) rows.set(s.id, { sprintId: row.id, name: row.name, goal: row.goal, startAt: row.startAt, endAt: row.endAt, state: row.state });
  }
  const ordered = [...sprints].filter((s) => rows.has(s.id)).sort((a, b) => (a.state === "closed" ? 0 : 1) - (b.state === "closed" ? 0 : 1));

  let sprintsStarted = 0;
  let sprintsCompleted = 0;
  for (const s of ordered) {
    const row = rows.get(s.id)!;
    const startAt = toDate(s.startDate) ?? null;
    const endAt = toDate(s.completeDate) ?? toDate(s.endDate) ?? null;
    const differs = row.name !== s.name || (row.goal ?? "") !== (s.goal ?? "") || (row.startAt?.getTime() ?? null) !== (startAt?.getTime() ?? null) || (row.endAt?.getTime() ?? null) !== (endAt?.getTime() ?? null);
    if (differs) await updateImportedSprint(tx, { sprintId: row.sprintId, name: s.name, goal: s.goal ?? null, startAt, endAt });
    if (s.state === "closed" && row.state === "active") {
      await completeImportedSprint(tx, { sprintId: row.sprintId, completedAt: toDate(s.completeDate) ?? new Date() });
      sprintsCompleted++;
    }
  }
  for (const s of ordered) {
    const row = rows.get(s.id)!;
    if (s.state === "active" && row.state === "future") {
      const [active] = await tx.select({ id: schema.sprint.id }).from(schema.sprint).where(and(eq(schema.sprint.boardId, boardId), eq(schema.sprint.state, "active")));
      if (active) continue; // JIRA has two active sprints: the one-per-board rule keeps this one future, as the import does.
      await activateImportedSprint(tx, { sprintId: row.sprintId, startAt: toDate(s.startDate) ?? new Date(), endAt: toDate(s.endDate) });
      sprintsStarted++;
    }
  }
  return { sprintsStarted, sprintsCompleted };
}

/** A placeholder mention's JIRA target, as the importer knows it: the imported issue's id, number and title. */
type MentionTarget = { issueId: string; keySeq: number; title: string };

/**
 * Points every issueMention the converter left empty (issueId "") at the imported issue
 * its JIRA key names. external_ref is the lookup, not keySeq: a renumbered issue is
 * still found by its JIRA key, and the mention gets its new keySeq. A mention whose
 * issue never made it in becomes a plain link to JIRA. Only this project's imported
 * issues and comments are read (a LIKE prefilter keeps it off the rest), and only the
 * rows that change are written, with updated_at left alone.
 */
async function resolveIssueMentions(tx: Tx, ctx: JiraLoadContext): Promise<{ resolved: number; unresolved: number }> {
  const jiraProjectKey = ctx.jiraProjectKey;
  if (!jiraProjectKey) return { resolved: 0, unresolved: 0 };

  const refs = await tx
    .select({ jiraKey: schema.externalRef.sourceId, issueId: schema.issue.id, keySeq: schema.issue.keySeq, title: schema.issue.title })
    .from(schema.externalRef)
    .innerJoin(schema.issue, eq(schema.issue.id, schema.externalRef.entityId))
    .where(
      and(
        eq(schema.externalRef.organizationId, ctx.organizationId),
        eq(schema.externalRef.source, "jira"),
        eq(schema.externalRef.entityType, "issue"),
        eq(schema.issue.projectId, ctx.projectId),
      ),
    );
  const targetByJiraKey = new Map<string, MentionTarget>(refs.map((r) => [r.jiraKey, { issueId: r.issueId, keySeq: r.keySeq, title: r.title }]));

  const jiraBase = ctx.jiraBaseUrl?.replace(/\/+$/, "");
  let resolved = 0;
  let unresolved = 0;
  const fill = (props: Record<string, unknown>): unknown[] => {
    const jiraKey = `${jiraProjectKey}-${String(props.keySeq ?? "")}`;
    const target = targetByJiraKey.get(jiraKey);
    if (target) {
      resolved++;
      return [{ type: "issueMention", props: { ...props, issueId: target.issueId, keySeq: String(target.keySeq), title: target.title } }];
    }
    unresolved++;
    const text = { type: "text", text: jiraKey, styles: {} };
    return jiraBase ? [{ type: "link", href: `${jiraBase}/browse/${jiraKey}`, content: [text] }] : [text];
  };

  const descriptionRows = await tx
    .select({ id: schema.issue.id, value: schema.issue.descriptionJson })
    .from(schema.issue)
    .where(
      and(eq(schema.issue.projectId, ctx.projectId), eq(schema.issue.origin, "import"), sql`${schema.issue.descriptionJson}::text like ${'%"issueMention"%'}`),
    );
  for (const row of descriptionRows) {
    const rewritten = rewriteIssueMentions(row.value, fill);
    if (rewritten.changed) {
      await tx.update(schema.issue).set({ descriptionJson: rewritten.value as Json }).where(eq(schema.issue.id, row.id));
      await enqueueReindex(tx, { organizationId: ctx.organizationId, entityType: "issue", entityId: row.id });
    }
  }

  const commentRows = await tx
    .select({ id: schema.issueComment.id, value: schema.issueComment.bodyJson })
    .from(schema.issueComment)
    .innerJoin(schema.issue, eq(schema.issue.id, schema.issueComment.issueId))
    .where(
      and(eq(schema.issue.projectId, ctx.projectId), eq(schema.issueComment.origin, "import"), sql`${schema.issueComment.bodyJson}::text like ${'%"issueMention"%'}`),
    );
  for (const row of commentRows) {
    const rewritten = rewriteIssueMentions(row.value, fill);
    if (rewritten.changed) {
      await tx.update(schema.issueComment).set({ bodyJson: rewritten.value as Json }).where(eq(schema.issueComment.id, row.id));
      await enqueueReindex(tx, { organizationId: ctx.organizationId, entityType: "comment", entityId: row.id });
    }
  }

  return { resolved, unresolved };
}

/**
 * Walks a Block[] tree (inline content, link children, table cells, nested blocks)
 * and replaces each issueMention whose issueId is empty with fill()'s nodes. Returns
 * the new tree, and whether anything changed. Any other value passes through as is.
 */
function rewriteIssueMentions(value: unknown, fill: (props: Record<string, unknown>) => unknown[]): { value: unknown; changed: boolean } {
  if (!Array.isArray(value)) return { value, changed: false };
  let changed = false;

  const inlineList = (list: unknown[]): unknown[] =>
    list.flatMap((node): unknown[] => {
      if (!node || typeof node !== "object") return [node];
      const n = node as { type?: string; props?: Record<string, unknown>; content?: unknown };
      if (n.type === "issueMention" && n.props && n.props.issueId === "") {
        changed = true;
        return fill(n.props);
      }
      if (n.type === "link" && Array.isArray(n.content)) return [{ ...n, content: inlineList(n.content) }];
      return [node];
    });

  const block = (b: unknown): unknown => {
    if (!b || typeof b !== "object") return b;
    const x = b as { content?: unknown; children?: unknown };
    const out: Record<string, unknown> = { ...x };
    if (Array.isArray(x.content)) out.content = inlineList(x.content);
    else if (x.content && typeof x.content === "object" && (x.content as { type?: string }).type === "tableContent") {
      const table = x.content as { rows?: unknown };
      if (Array.isArray(table.rows)) {
        out.content = {
          ...table,
          rows: table.rows.map((row) => {
            const cells = (row as { cells?: unknown })?.cells;
            if (!Array.isArray(cells)) return row;
            return {
              ...(row as object),
              cells: cells.map((cell) => {
                if (Array.isArray(cell)) return inlineList(cell);
                const c = cell as { content?: unknown } | null;
                return c && Array.isArray(c.content) ? { ...c, content: inlineList(c.content) } : cell;
              }),
            };
          }),
        };
      }
    }
    if (Array.isArray(x.children)) out.children = x.children.map(block);
    return out;
  };

  return { value: value.map(block), changed };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function toSprintMapping(p: PlannedSprint): JiraLoadReport["sprintMapping"][number] {
  return { jiraSprintId: p.jira.id, jiraSprintName: p.jira.name, state: p.state, number: p.number, action: p.action, kompastSprintId: p.kompastSprintId };
}

function sprintRefId(jiraSprintId: number): string {
  return `sprint:${jiraSprintId}`;
}

function toDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Decides, without writing anything, what each JIRA sprint becomes — so a
 * dry run shows the same sprint mapping a real run applies. Takes the sprint
 * list directly (deduped by id), not the issues.
 */
async function planSprints(tx: Tx, sprints: JiraSprint[], ctx: PlanTarget): Promise<PlannedSprint[]> {
  const byId = new Map<number, JiraSprint>();
  for (const s of sprints) byId.set(s.id, s);
  if (byId.size === 0) return [];

  // The plan order is orderJiraSprints' (shared with the reconcile and the sync's current-sprint rule).
  const sorted = orderJiraSprints([...byId.values()]);

  const existingActive = await getActiveSprint(tx, ctx.boardId);
  const usedNumbers = new Set(await listSprintNumbers(tx, ctx.boardId));
  let activeTaken = !!existingActive;
  let lastCreatedAt = 0;
  const now = Date.now();

  const plan: PlannedSprint[] = [];
  for (const s of sorted) {
    const startAt = toDate(s.startDate);
    const endAt = toDate(s.completeDate) ?? toDate(s.endDate);
    let createdAtMs = s.state === "future" ? now : (startAt ?? endAt)?.getTime() ?? lastCreatedAt + 1;
    if (createdAtMs <= lastCreatedAt) createdAtMs = lastCreatedAt + 1;
    lastCreatedAt = createdAtMs;

    const ref = await resolveExternalRef(tx, ctx.organizationId, "jira", sprintRefId(s.id));
    const base = { jira: s, startAt, endAt, createdAt: new Date(createdAtMs) };
    if (ref) {
      const [row] = await tx.select({ number: schema.sprint.number, state: schema.sprint.state }).from(schema.sprint).where(eq(schema.sprint.id, ref.entityId));
      if (row) {
        plan.push({ ...base, state: row.state, number: row.number, action: "already-imported", kompastSprintId: ref.entityId });
        if (row.state === "active") activeTaken = true;
        continue;
      }
    }

    if (s.state === "active" && existingActive && !plan.some((p) => p.kompastSprintId === existingActive.id)) {
      plan.push({ ...base, state: "active", number: existingActive.number, action: "existing-active", kompastSprintId: existingActive.id });
      continue;
    }

    let state = s.state;
    if (state === "active") {
      if (activeTaken) state = "future";
      else activeTaken = true;
    }
    plan.push({ ...base, state, number: 0, action: "create", kompastSprintId: null });
  }

  // Numbers: keep the one in the JIRA name when it's free; the rest get the
  // next free number after everything else, in sprint order.
  const toCreate = plan.filter((p) => p.action === "create");
  const needsNumber: PlannedSprint[] = [];
  for (const p of toCreate) {
    const n = parseJiraSprintNumber(p.jira.name);
    if (n !== null && !usedNumbers.has(n)) {
      p.number = n;
      usedNumbers.add(n);
    } else {
      needsNumber.push(p);
    }
  }
  let next = Math.max(0, ...usedNumbers) + 1;
  for (const p of needsNumber) {
    p.number = next++;
    usedNumbers.add(p.number);
  }
  return plan;
}

function mapLinkType(jiraLinkTypeName: string): LinkType {
  const name = jiraLinkTypeName.toLowerCase();
  if (name.includes("block")) return "blocks";
  if (name.includes("duplicate")) return "duplicates";
  if (name.includes("clone")) return "clones";
  return "relates";
}
