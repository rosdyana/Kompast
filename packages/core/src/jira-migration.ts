import { and, asc, eq, inArray, schema, sql, type Json } from "@kompast/db";
import type { AnyDb, Tx } from "./types";
import { id } from "./ids";
import { encryptSecret, decryptSecret } from "./crypto";
import { createImportRun } from "./import";
import { requireProjectAccess, requireProjectAdmin, type AuthContext } from "./permissions";
import { requeueFailedImportedAttachments } from "./attachment";
import { listPriorityLevels } from "./priority";
import { ISSUE_PROPERTY_TYPES, listIssuePropertyDefinitions, type IssuePropertyType } from "./issue-property";

/**
 * JIRA -> Kompast migration record. One row per project; the long-lived
 * state the wizard and apps/worker's batched runner both read.
 * See packages/db/src/schema/import.ts's jiraMigration doc comment.
 *
 * Tenant-scoped functions take `tx: Tx` and must be called inside
 * withAuthorizedTenant. The user-facing ones also take `ctx` and check
 * project-admin rights (requireProjectAdmin) before touching the row. The
 * worker-facing functions take `db: AnyDb` and are only called from
 * apps/worker on the admin connection (lease claim across every workspace,
 * the same exception as claimPendingEmails).
 */

/** How long a worker lease lasts before another process may claim the migration. */
export const JIRA_MIGRATION_LEASE_MS = 5 * 60_000;

export type JiraMigrationRow = typeof schema.jiraMigration.$inferSelect;

/** A migration row with the encrypted token replaced by a boolean. Every read API returns this shape, never the ciphertext. */
export type JiraMigrationPublic = Omit<JiraMigrationRow, "apiTokenEncrypted"> & { hasToken: boolean };

function toPublic(row: JiraMigrationRow): JiraMigrationPublic {
  const { apiTokenEncrypted, ...rest } = row;
  return { ...rest, hasToken: apiTokenEncrypted !== null };
}

// ── Mapping shape and targets ───────────────────────────────────────────────
//
// Defined here (not in packages/import) because core cannot depend on
// @kompast/import; packages/import/src/jira/mapping.ts re-exports these.

export type JiraStatusCategory = "todo" | "in_progress" | "done";

/** Where a status created by the migration lands on the board. `new` makes a column after `afterColumnId` (null = first position); `join` adds the status to an existing column. */
export type JiraStatusColumnPlacement = { mode: "new"; afterColumnId: string | null } | { mode: "join"; columnId: string };

/** The issue fields a JIRA field can fill directly (not as a custom property). */
export const JIRA_CORE_FIELDS = ["storyPoints", "startDate", "dueDate", "estimateSeconds"] as const;
export type JiraCoreField = (typeof JIRA_CORE_FIELDS)[number];

/**
 * One JIRA field's choice: a core field, an existing or new custom property,
 * or nothing. `transform` converts a number (secondsToHours: JIRA's seconds to
 * hours) and is only valid on a number property.
 */
export interface JiraFieldMapping {
  jiraFieldId: string;
  jiraName: string;
  action: "core" | "property" | "skip";
  coreField?: JiraCoreField;
  /** An existing property (by key) to write into. */
  propertyKey?: string;
  /** A property to create at prepare time (or reuse, when a re-run finds one with the same name and type). */
  create?: { name: string; type: IssuePropertyType };
  transform?: "secondsToHours";
}

export interface JiraMigrationMapping {
  statuses: {
    jiraName: string;
    category: JiraStatusCategory;
    action: "map" | "create";
    kompastStatusId?: string;
    /** Only meaningful for "create". Absent = the status gets a column at the end of the board. */
    column?: JiraStatusColumnPlacement;
  }[];
  types: { jiraName: string; action: "map" | "create"; kompastTypeId?: string }[];
  people: { accountId: string; displayName: string; action: "map" | "former"; kompastUserId?: string; confidence: "email" | "name" | "none" }[];
  /** One entry per priority name, pointing at a key of the project's priority_level rows. A saved mapping from before this field existed reads as []: the loader then uses the suggestion. */
  priorities: { jiraName: string; kompastKey: string }[];
  /** Attachments above this many bytes are skipped. null = no limit. Default 10 MiB. */
  attachmentMaxBytes: number | null;
  /**
   * The choice for each used JIRA field the loader doesn't handle itself. Absent on a mapping saved before this
   * field existed: the next scan suggests it, and the loader writes no field values until then.
   */
  fields?: JiraFieldMapping[];
}

/** What the mapping may point at: the project's own statuses, types and people, and the migration board's columns. */
export interface JiraMappingTargets {
  statuses: { id: string; name: string; category: JiraStatusCategory }[];
  types: { id: string; name: string }[];
  /** Distinct users who are project members or members of the project's team. `email` is null when the account has none. */
  members: { userId: string; name: string; email: string | null }[];
  /** The migration board's columns, by order, with the status ids each one shows. */
  columns: { id: string; name: string; order: number; statusIds: string[] }[];
  /** The project's own priority levels, in order. `key` is what issue.priority stores. */
  priorities: { key: string; name: string }[];
  /** The project's issue property definitions, core and custom. Absent = none. A field may only write into a custom one. */
  properties?: { key: string; name: string; type: IssuePropertyType; isCore: boolean }[];
}

/**
 * Everything the wizard's dropdowns and the runner's suggestion need about
 * the target project and its migration board. Read-only.
 */
export async function listJiraMappingTargets(tx: Tx, projectId: string, boardId: string): Promise<JiraMappingTargets> {
  const statuses = await tx
    .select({ id: schema.workflowStatus.id, name: schema.workflowStatus.name, category: schema.workflowStatus.category })
    .from(schema.workflowStatus)
    .where(eq(schema.workflowStatus.projectId, projectId))
    .orderBy(asc(schema.workflowStatus.order));

  const types = await tx
    .select({ id: schema.issueType.id, name: schema.issueType.name })
    .from(schema.issueType)
    .where(eq(schema.issueType.projectId, projectId))
    .orderBy(asc(schema.issueType.order));

  const [projectRow] = await tx.select({ teamId: schema.project.teamId }).from(schema.project).where(eq(schema.project.id, projectId));
  const projectMembers = await tx
    .select({ userId: schema.projectMember.userId, name: schema.user.name, email: schema.user.email })
    .from(schema.projectMember)
    .innerJoin(schema.user, eq(schema.user.id, schema.projectMember.userId))
    .where(eq(schema.projectMember.projectId, projectId));
  const teamMembers = projectRow?.teamId
    ? await tx
        .select({ userId: schema.teamMember.userId, name: schema.user.name, email: schema.user.email })
        .from(schema.teamMember)
        .innerJoin(schema.user, eq(schema.user.id, schema.teamMember.userId))
        .where(eq(schema.teamMember.teamId, projectRow.teamId))
    : [];
  const membersById = new Map<string, { userId: string; name: string; email: string | null }>();
  for (const m of [...projectMembers, ...teamMembers]) {
    if (!membersById.has(m.userId)) membersById.set(m.userId, { userId: m.userId, name: m.name, email: m.email ?? null });
  }
  const members = [...membersById.values()].sort((a, b) => a.name.localeCompare(b.name));

  const columnRows = await tx
    .select({ id: schema.boardColumn.id, name: schema.boardColumn.name, order: schema.boardColumn.order })
    .from(schema.boardColumn)
    .where(eq(schema.boardColumn.boardId, boardId))
    .orderBy(asc(schema.boardColumn.order));
  const links = columnRows.length
    ? await tx
        .select({ columnId: schema.boardColumnStatus.boardColumnId, statusId: schema.boardColumnStatus.workflowStatusId })
        .from(schema.boardColumnStatus)
        .where(
          inArray(
            schema.boardColumnStatus.boardColumnId,
            columnRows.map((c) => c.id),
          ),
        )
    : [];
  const columns = columnRows.map((c) => ({
    id: c.id,
    name: c.name,
    order: c.order,
    statusIds: links.filter((l) => l.columnId === c.id).map((l) => l.statusId),
  }));

  const definitions = await listIssuePropertyDefinitions(tx, projectId);

  return {
    statuses,
    types,
    members,
    columns,
    priorities: (await listPriorityLevels(tx, projectId)).map((level) => ({ key: level.key, name: level.name })),
    properties: definitions.map((d) => ({ key: d.key, name: d.name, type: d.type, isCore: d.isCore })),
  };
}

// ── Mapping validation ──────────────────────────────────────────────────────

const STATUS_CATEGORIES: ReadonlySet<string> = new Set<JiraStatusCategory>(["todo", "in_progress", "done"]);
const CONFIDENCES: ReadonlySet<string> = new Set(["email", "name", "none"]);
/** The largest attachment limit the mapping accepts: 2 GiB. */
export const MAX_JIRA_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(message);
  return value;
}

function parseColumnPlacement(raw: unknown, jiraName: string, columnIds: ReadonlySet<string>): JiraStatusColumnPlacement | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new Error(`${jiraName}: the column placement is malformed`);
  if (raw.mode === "new") {
    const after = raw.afterColumnId;
    if (after !== null && !(typeof after === "string" && columnIds.has(after))) {
      throw new Error(`${jiraName}: "new column after" must name a column of this board, or be the start`);
    }
    return { mode: "new", afterColumnId: after };
  }
  if (raw.mode === "join") {
    if (typeof raw.columnId !== "string" || !columnIds.has(raw.columnId)) {
      throw new Error(`${jiraName}: "add to column" must name a column of this board`);
    }
    return { mode: "join", columnId: raw.columnId };
  }
  throw new Error(`${jiraName}: the column placement needs mode "new" or "join"`);
}

const CORE_FIELD_SET: ReadonlySet<string> = new Set<string>(JIRA_CORE_FIELDS);
const PROPERTY_TYPE_SET: ReadonlySet<string> = new Set<string>(ISSUE_PROPERTY_TYPES);
/** The longest name a migration may give a new property. */
const MAX_PROPERTY_NAME_LENGTH = 80;

/** A property name's key form, as createIssuePropertyDefinition slugs it. Used only to spot reserved names. */
function slugOfName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** A new property may not take the reserved key "jira", nor the name or key of a core property. */
function isReservedPropertyName(name: string, properties: NonNullable<JiraMappingTargets["properties"]>): boolean {
  const lower = name.trim().toLowerCase();
  const slug = slugOfName(name);
  if (slug === "jira") return true;
  return properties.some((p) => p.isCore && (p.name.toLowerCase() === lower || p.key.toLowerCase() === lower || p.key.toLowerCase() === slug));
}

/**
 * Validates the fields list. Undefined (an older mapping) stays undefined. Each
 * entry names a JIRA field, and its action decides what else it needs: a core
 * target (used once across the list), an existing custom property, or a new one
 * (name and type). A number transform is only allowed on a number property.
 */
function parseFieldMappings(raw: unknown, targets: JiraMappingTargets): JiraFieldMapping[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error("The fields list is malformed");

  const properties = targets.properties ?? [];
  const propertyByKey = new Map(properties.filter((p) => !p.isCore).map((p) => [p.key, p]));
  const coreClaimedBy = new Map<string, string>();
  const seenFieldIds = new Set<string>();

  return raw.map((entry): JiraFieldMapping => {
    if (!isRecord(entry)) throw new Error("A field mapping entry is malformed");
    const jiraFieldId = requireText(entry.jiraFieldId, "Every JIRA field needs an id");
    const jiraName = requireText(entry.jiraName, `${jiraFieldId}: the field name is missing`);
    if (seenFieldIds.has(jiraFieldId)) throw new Error(`${jiraName}: the field is listed twice`);
    seenFieldIds.add(jiraFieldId);
    const base = { jiraFieldId, jiraName };

    if (entry.transform !== undefined && entry.transform !== null && entry.transform !== "secondsToHours") {
      throw new Error(`${jiraName}: the only transform is secondsToHours`);
    }
    const wantsTransform = entry.transform === "secondsToHours";

    if (entry.action === "skip") return { ...base, action: "skip" };

    if (entry.action === "core") {
      if (typeof entry.coreField !== "string" || !CORE_FIELD_SET.has(entry.coreField)) {
        throw new Error(`${jiraName}: choose a core field to fill`);
      }
      const coreField = entry.coreField as JiraCoreField;
      const claimedBy = coreClaimedBy.get(coreField);
      if (claimedBy) throw new Error(`${jiraName}: ${claimedBy} already fills this core field`);
      coreClaimedBy.set(coreField, jiraName);
      if (wantsTransform) throw new Error(`${jiraName}: a transform only applies to a number property`);
      return { ...base, action: "core", coreField };
    }

    if (entry.action === "property") {
      if (entry.create !== undefined && entry.create !== null) {
        if (!isRecord(entry.create)) throw new Error(`${jiraName}: the new property is malformed`);
        const name = requireText(entry.create.name, `${jiraName}: name the new property`).trim();
        if (name.length === 0) throw new Error(`${jiraName}: name the new property`);
        if (name.length > MAX_PROPERTY_NAME_LENGTH) throw new Error(`${jiraName}: the property name is longer than ${MAX_PROPERTY_NAME_LENGTH} characters`);
        if (typeof entry.create.type !== "string" || !PROPERTY_TYPE_SET.has(entry.create.type)) {
          throw new Error(`${jiraName}: the property type is not one Kompast has`);
        }
        const type = entry.create.type as IssuePropertyType;
        if (isReservedPropertyName(name, properties)) throw new Error(`${jiraName}: "${name}" is a reserved name, choose another`);
        if (wantsTransform && type !== "number") throw new Error(`${jiraName}: a transform only applies to a number property`);
        return { ...base, action: "property", create: { name, type }, ...(wantsTransform ? { transform: "secondsToHours" as const } : {}) };
      }
      const propertyKey = requireText(entry.propertyKey, `${jiraName}: choose a property or create one`);
      const existing = propertyByKey.get(propertyKey);
      if (!existing) throw new Error(`${jiraName}: that property is not in this project`);
      if (wantsTransform && existing.type !== "number") throw new Error(`${jiraName}: a transform only applies to a number property`);
      return { ...base, action: "property", propertyKey, ...(wantsTransform ? { transform: "secondsToHours" as const } : {}) };
    }

    throw new Error(`${jiraName}: the action must be "core", "property" or "skip"`);
  });
}

/**
 * Checks a mapping the user sent against what this project and board can
 * actually hold, and returns a clean copy. Unknown keys are dropped (the
 * rebuilt objects only carry the fields below), so what's stored is exactly
 * the documented shape. Throws a readable Error on the first problem.
 */
export function parseJiraMigrationMapping(raw: unknown, targets: JiraMappingTargets): JiraMigrationMapping {
  if (!isRecord(raw)) throw new Error("The mapping must be an object");
  if (!Array.isArray(raw.statuses) || !Array.isArray(raw.types) || !Array.isArray(raw.people)) {
    throw new Error("The mapping needs statuses, types and people lists");
  }

  const statusIds = new Set(targets.statuses.map((s) => s.id));
  const typeIds = new Set(targets.types.map((t) => t.id));
  const memberIds = new Set(targets.members.map((m) => m.userId));
  const columnIds = new Set(targets.columns.map((c) => c.id));
  const priorityKeys = new Set(targets.priorities.map((p) => p.key));

  const statuses = raw.statuses.map((entry): JiraMigrationMapping["statuses"][number] => {
    if (!isRecord(entry)) throw new Error("A status mapping entry is malformed");
    const jiraName = requireText(entry.jiraName, "Every JIRA status needs a name");
    if (typeof entry.category !== "string" || !STATUS_CATEGORIES.has(entry.category)) {
      throw new Error(`${jiraName}: the category must be to do, in progress or done`);
    }
    const category = entry.category as JiraStatusCategory;

    if (entry.action === "map") {
      const kompastStatusId = requireText(entry.kompastStatusId, `${jiraName}: choose a Kompast status`);
      if (!statusIds.has(kompastStatusId)) throw new Error(`${jiraName}: that Kompast status is not in this project`);
      return { jiraName, category, action: "map", kompastStatusId };
    }
    if (entry.action === "create") {
      const column = parseColumnPlacement(entry.column, jiraName, columnIds);
      return column ? { jiraName, category, action: "create", column } : { jiraName, category, action: "create" };
    }
    throw new Error(`${jiraName}: the action must be "map" or "create"`);
  });

  const types = raw.types.map((entry): JiraMigrationMapping["types"][number] => {
    if (!isRecord(entry)) throw new Error("An issue type mapping entry is malformed");
    const jiraName = requireText(entry.jiraName, "Every JIRA issue type needs a name");
    if (entry.action === "map") {
      const kompastTypeId = requireText(entry.kompastTypeId, `${jiraName}: choose a Kompast issue type`);
      if (!typeIds.has(kompastTypeId)) throw new Error(`${jiraName}: that issue type is not in this project`);
      return { jiraName, action: "map", kompastTypeId };
    }
    if (entry.action === "create") return { jiraName, action: "create" };
    throw new Error(`${jiraName}: the action must be "map" or "create"`);
  });

  const people = raw.people.map((entry): JiraMigrationMapping["people"][number] => {
    if (!isRecord(entry)) throw new Error("A person mapping entry is malformed");
    const accountId = requireText(entry.accountId, "Every JIRA person needs an account id");
    const displayName = requireText(entry.displayName, `${accountId}: the display name is missing`);
    if (typeof entry.confidence !== "string" || !CONFIDENCES.has(entry.confidence)) {
      throw new Error(`${displayName}: the match confidence is invalid`);
    }
    const confidence = entry.confidence as "email" | "name" | "none";
    if (entry.action === "map") {
      const kompastUserId = requireText(entry.kompastUserId, `${displayName}: choose a Kompast member`);
      if (!memberIds.has(kompastUserId)) throw new Error(`${displayName}: that person is not a member of this project or its team`);
      return { accountId, displayName, action: "map", kompastUserId, confidence };
    }
    if (entry.action === "former") return { accountId, displayName, action: "former", confidence };
    throw new Error(`${displayName}: the action must be "map" or "former"`);
  });

  if (raw.priorities !== undefined && !Array.isArray(raw.priorities)) throw new Error("The priorities list is malformed");
  const priorities = (Array.isArray(raw.priorities) ? raw.priorities : []).map((entry): JiraMigrationMapping["priorities"][number] => {
    if (!isRecord(entry)) throw new Error("A priority mapping entry is malformed");
    const jiraName = requireText(entry.jiraName, "Every JIRA priority needs a name");
    const kompastKey = requireText(entry.kompastKey, `${jiraName}: choose a Kompast priority`);
    if (!priorityKeys.has(kompastKey)) throw new Error(`${jiraName}: that priority is not in this project`);
    return { jiraName, kompastKey };
  });

  const limit = raw.attachmentMaxBytes;
  let attachmentMaxBytes: number | null;
  if (limit === null) {
    attachmentMaxBytes = null;
  } else if (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_JIRA_ATTACHMENT_BYTES) {
    attachmentMaxBytes = limit;
  } else {
    throw new Error("The attachment size limit must be a whole number of bytes between 1 and 2 GB, or no limit");
  }

  const fields = parseFieldMappings(raw.fields, targets);

  return { statuses, types, people, priorities, attachmentMaxBytes, ...(fields ? { fields } : {}) };
}

// ── User-facing record lifecycle (permission-checked) ───────────────────────

export interface CreateJiraMigrationInput {
  projectId: string;
  /** The Kompast board the imported sprints/issues land on. Must belong to projectId. */
  boardId: string;
  siteUrl: string;
  email: string;
  apiToken: string;
  jiraProjectKey: string;
  jiraBoardId?: number | null;
}

/** Creates the migration in state "draft". The caller must be a project admin; the creator is ctx.userId. */
export async function createJiraMigration(tx: Tx, ctx: AuthContext, input: CreateJiraMigrationInput): Promise<{ migrationId: string }> {
  await requireProjectAdmin(tx, { ...ctx, projectId: input.projectId });

  const [board] = await tx
    .select({ id: schema.board.id })
    .from(schema.board)
    .where(and(eq(schema.board.id, input.boardId), eq(schema.board.projectId, input.projectId)));
  if (!board) throw new Error("The board does not belong to this project");

  const [existing] = await tx.select({ id: schema.jiraMigration.id }).from(schema.jiraMigration).where(eq(schema.jiraMigration.projectId, input.projectId));
  if (existing) throw new Error("This project already has a JIRA migration");

  const migrationId = id("jiramig");
  await tx.insert(schema.jiraMigration).values({
    id: migrationId,
    organizationId: ctx.organizationId,
    projectId: input.projectId,
    boardId: input.boardId,
    createdBy: ctx.userId,
    siteUrl: input.siteUrl.replace(/\/+$/, ""),
    email: input.email,
    apiTokenEncrypted: encryptSecret(input.apiToken),
    jiraProjectKey: input.jiraProjectKey,
    jiraBoardId: input.jiraBoardId ?? null,
  });
  return { migrationId };
}

async function loadRow(tx: Tx, migrationId: string): Promise<JiraMigrationRow> {
  const [row] = await tx.select().from(schema.jiraMigration).where(eq(schema.jiraMigration.id, migrationId));
  if (!row) throw new Error(`JIRA migration ${migrationId} not found`);
  return row;
}

/** Loads the row and checks the caller may manage its project. Every user-facing mutation starts here. */
async function loadManagedRow(tx: Tx, ctx: AuthContext, migrationId: string): Promise<JiraMigrationRow> {
  const row = await loadRow(tx, migrationId);
  await requireProjectAdmin(tx, { ...ctx, projectId: row.projectId });
  return row;
}

export async function getJiraMigration(tx: Tx, migrationId: string): Promise<JiraMigrationPublic | null> {
  const [row] = await tx.select().from(schema.jiraMigration).where(eq(schema.jiraMigration.id, migrationId));
  return row ? toPublic(row) : null;
}

export async function getJiraMigrationForProject(tx: Tx, projectId: string): Promise<JiraMigrationPublic | null> {
  const [row] = await tx.select().from(schema.jiraMigration).where(eq(schema.jiraMigration.projectId, projectId));
  return row ? toPublic(row) : null;
}

/**
 * The newest import run started by this migration, or null. `errorCount` is
 * the number of recorded errors, not the errors themselves.
 */
export async function getLatestJiraMigrationRun(tx: Tx, migrationId: string) {
  const [run] = await tx
    .select()
    .from(schema.importRun)
    .where(eq(schema.importRun.migrationId, migrationId))
    .orderBy(sql`${schema.importRun.createdAt} desc`)
    .limit(1);
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    counts: run.counts,
    errorCount: Array.isArray(run.errors) ? run.errors.length : 0,
    startedAt: run.startedAt,
    finishedAt: run.completedAt,
    createdAt: run.createdAt,
  };
}

export interface UpdateJiraMigrationCredentialsInput {
  email?: string;
  apiToken?: string;
}

/** Replacing the token un-clears it (tokenClearedAt back to null), e.g. to re-run a completed migration. */
export async function updateJiraMigrationCredentials(tx: Tx, ctx: AuthContext, migrationId: string, input: UpdateJiraMigrationCredentialsInput): Promise<void> {
  await loadManagedRow(tx, ctx, migrationId);
  const values: { email?: string; apiTokenEncrypted?: string; tokenClearedAt?: null; updatedAt: Date } = { updatedAt: new Date() };
  if (input.email !== undefined) values.email = input.email;
  if (input.apiToken !== undefined) {
    values.apiTokenEncrypted = encryptSecret(input.apiToken);
    values.tokenClearedAt = null;
  }
  await tx.update(schema.jiraMigration).set(values).where(eq(schema.jiraMigration.id, migrationId));
}

const DISCOVERABLE_STATES = new Set(["draft", "ready", "synced", "failed"]);

/** Queues a survey of the JIRA project. Allowed from draft, ready, synced or failed. */
export async function requestJiraDiscovery(tx: Tx, ctx: AuthContext, migrationId: string): Promise<void> {
  const row = await loadManagedRow(tx, ctx, migrationId);
  if (!DISCOVERABLE_STATES.has(row.state)) {
    throw new Error(`Cannot scan JIRA while the migration is "${row.state}"`);
  }
  await tx
    .update(schema.jiraMigration)
    .set({ state: "discovering", error: null, progress: { phase: "discovery", done: 0, total: null }, updatedAt: new Date() })
    .where(eq(schema.jiraMigration.id, migrationId));
}

const MAPPABLE_STATES = new Set(["ready", "synced", "failed"]);

/**
 * Validates and saves the user's mapping. Allowed from ready, synced or
 * failed. Validation needs the project's statuses/types/people and the
 * migration board's columns, so it runs inside the caller's tenant tx.
 */
export async function saveJiraMigrationMapping(tx: Tx, ctx: AuthContext, migrationId: string, mapping: unknown): Promise<void> {
  const row = await loadManagedRow(tx, ctx, migrationId);
  if (!MAPPABLE_STATES.has(row.state)) {
    throw new Error(`Cannot change the mapping while the migration is "${row.state}"`);
  }
  const targets = await listJiraMappingTargets(tx, row.projectId, row.boardId);
  const clean = parseJiraMigrationMapping(mapping, targets);
  await tx
    .update(schema.jiraMigration)
    .set({ mapping: clean as unknown as Json, updatedAt: new Date() })
    .where(eq(schema.jiraMigration.id, migrationId));
}

const STARTABLE_STATES = new Set(["ready", "synced", "failed"]);

/**
 * "full" re-reads the whole project (a repair, or the first run). "sync" re-reads only what JIRA changed since the
 * last finished run, plus the metadata and the key list (see packages/import/src/jira/migration-runner.ts).
 * "reconcile" reads both sides and compares them, changing no data. It is allowed from "synced" only.
 */
export type JiraRunMode = "full" | "sync" | "reconcile";

/** What a sync may be followed by. "reconcile" chains a completeness check after the sync's data is in. */
export type JiraRunThen = "reconcile";

/**
 * The saved state a reconcile run starts from. The import package (the runner) fills in the rest of the cursor
 * (its phases and counts) on its first tick. Only the fields that identify the run are set here.
 */
export function reconcileCursorOf(importRunId: string, startedAt: Date): Record<string, unknown> {
  return { importRunId, mode: "reconcile", startedAt: startedAt.toISOString(), nextPageToken: null, pagesDone: 0, attemptsOnPage: 0 };
}

/**
 * Opens a reconcile import_run for the migration (config mode "reconcile"). Writes nothing else: the caller sets the
 * migration's state and cursor. Used by a user's "check completeness" and by a sync chained into a reconcile.
 */
export async function openJiraReconcileRun(
  tx: Tx,
  migration: Pick<JiraMigrationRow, "id" | "organizationId" | "projectId" | "siteUrl" | "jiraProjectKey">,
  createdBy: string,
  startedAt: Date,
): Promise<{ importRunId: string; cursor: Record<string, unknown> }> {
  const { importRunId } = await createImportRun(tx, {
    organizationId: migration.organizationId,
    projectId: migration.projectId,
    source: "jira",
    dryRun: false,
    config: { siteUrl: migration.siteUrl, jiraProjectKey: migration.jiraProjectKey, mode: "reconcile" },
    createdBy,
    migrationId: migration.id,
  });
  return { importRunId, cursor: reconcileCursorOf(importRunId, startedAt) };
}

/** The auto-sync intervals the wizard offers, in minutes. null turns auto-sync off. */
export const JIRA_AUTO_SYNC_MINUTES = [15, 60, 240] as const;
export type JiraAutoSyncMinutes = (typeof JIRA_AUTO_SYNC_MINUTES)[number];

/**
 * Starts a (re-)run of the migration: creates the import_run, resets the
 * cursor to the first page, and moves the migration to "running". The
 * runner does the actual work from here (packages/import/src/jira/migration-runner.ts).
 *
 * The mode defaults to "sync" once the migration has finished a run (lastSyncedAt is set), else "full". A sync
 * needs that finished run, so asking for one before it is refused. The moment the run starts is saved in the
 * cursor as startedAt: it becomes lastSyncedAt when the run finishes, so issues JIRA changed while the run was going
 * are picked up by the next sync.
 */
export async function startJiraMigrationRun(
  tx: Tx,
  ctx: AuthContext,
  migrationId: string,
  opts: { mode?: JiraRunMode; then?: JiraRunThen } = {},
): Promise<{ importRunId: string; mode: JiraRunMode }> {
  const migration = await loadManagedRow(tx, ctx, migrationId);
  const mode: JiraRunMode = opts.mode ?? (migration.lastSyncedAt ? "sync" : "full");

  if (mode === "reconcile") {
    if (migration.state !== "synced") throw new Error(`Check completeness after a finished sync (this migration is "${migration.state}")`);
  } else if (!STARTABLE_STATES.has(migration.state)) {
    throw new Error(`Cannot start a JIRA import while the migration is "${migration.state}"`);
  }
  if (!migration.mapping) throw new Error("Save the mapping before starting the JIRA import");
  if (!migration.apiTokenEncrypted) throw new Error("This migration has no JIRA API token — enter it again to continue");
  if (opts.then && mode !== "sync") throw new Error("Only a sync can be followed by a reconcile");

  if (mode === "sync" && !migration.lastSyncedAt) throw new Error("A sync needs a finished import first. Run the full import instead.");
  const startedAt = new Date();

  if (mode === "reconcile") {
    // Reads both sides and compares them. Changes no data, so the attachment retry below doesn't apply.
    if (!migration.lastSyncedAt) throw new Error("Check completeness after a finished sync");
    const { importRunId, cursor } = await openJiraReconcileRun(tx, migration, ctx.userId, startedAt);
    await tx
      .update(schema.jiraMigration)
      .set({ state: "running", cursor: cursor as unknown as Json, progress: { phase: "reconcile", done: 0, total: null }, error: null, updatedAt: new Date() })
      .where(eq(schema.jiraMigration.id, migrationId));
    return { importRunId, mode };
  }

  const { importRunId } = await createImportRun(tx, {
    organizationId: migration.organizationId,
    projectId: migration.projectId,
    source: "jira",
    dryRun: false,
    config: { siteUrl: migration.siteUrl, jiraProjectKey: migration.jiraProjectKey, mode, ...(opts.then ? { then: opts.then } : {}) },
    createdBy: ctx.userId,
    migrationId,
  });

  // A re-run retries the copies that failed before. Stored files are left alone.
  await requeueFailedImportedAttachments(tx, migration.projectId);

  const issueCount = (migration.discovery as { issueCount?: unknown } | null)?.issueCount;
  const cursor = {
    importRunId,
    mode,
    startedAt: startedAt.toISOString(),
    nextPageToken: null,
    pagesDone: 0,
    attemptsOnPage: 0,
    deferredParents: [],
    deferredLinks: [],
    ...(opts.then ? { then: opts.then } : {}),
  };
  await tx
    .update(schema.jiraMigration)
    .set({
      state: "running",
      cursor,
      progress: mode === "sync" ? { phase: "sync", done: 0, total: null } : { phase: "data", done: 0, total: typeof issueCount === "number" ? issueCount : null },
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.jiraMigration.id, migrationId));

  return { importRunId, mode };
}

/**
 * Every import run this migration started, newest first. For the run history. A reconcile run's notes carry every
 * difference, so the list keeps only its summary (see getLatestJiraReconcile for the full run).
 */
export async function listJiraMigrationRuns(tx: Tx, migrationId: string) {
  const rows = await tx
    .select({
      id: schema.importRun.id,
      status: schema.importRun.status,
      config: schema.importRun.config,
      counts: schema.importRun.counts,
      errors: schema.importRun.errors,
      notes: schema.importRun.notes,
      createdAt: schema.importRun.createdAt,
      completedAt: schema.importRun.completedAt,
    })
    .from(schema.importRun)
    .where(eq(schema.importRun.migrationId, migrationId))
    .orderBy(sql`${schema.importRun.createdAt} desc`);
  return rows.map((r) => {
    if (!isReconcileConfig(r.config) || !r.notes || typeof r.notes !== "object" || Array.isArray(r.notes)) return r;
    const n = r.notes as { truncated?: unknown; clean?: unknown };
    return { ...r, notes: { truncated: typeof n.truncated === "number" ? n.truncated : 0, clean: typeof n.clean === "boolean" ? n.clean : null } as unknown as Json };
  });
}

function isReconcileConfig(config: Json): boolean {
  return !!config && typeof config === "object" && !Array.isArray(config) && (config as { mode?: unknown }).mode === "reconcile";
}

/** The unexplained differences across every category of a reconcile's counts. */
export function unexplainedTotalOf(counts: Json | null): number {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return 0;
  let total = 0;
  for (const category of Object.values(counts as Record<string, unknown>)) {
    const n = (category as { unexplained?: unknown } | null)?.unexplained;
    if (typeof n === "number") total += n;
  }
  return total;
}

/**
 * The newest completed reconcile of this migration, with its counts and notes (every difference), or null. Read
 * only. The Finish panel and finishJiraMigration both use it.
 */
export async function getLatestJiraReconcile(tx: Tx, migrationId: string) {
  const [run] = await tx
    .select()
    .from(schema.importRun)
    .where(
      and(
        eq(schema.importRun.migrationId, migrationId),
        eq(schema.importRun.status, "completed"),
        sql`${schema.importRun.config}->>'mode' = 'reconcile'`,
      ),
    )
    .orderBy(sql`${schema.importRun.completedAt} desc nulls last`)
    .limit(1);
  return run ?? null;
}

/**
 * Sets the auto-sync interval (null = off). Allowed in any state: it only decides when a worker starts a sync, and
 * the worker only starts one from "synced" with a token.
 */
export async function setJiraMigrationAutoSync(tx: Tx, ctx: AuthContext, migrationId: string, minutes: JiraAutoSyncMinutes | null): Promise<void> {
  if (minutes !== null && !(JIRA_AUTO_SYNC_MINUTES as readonly number[]).includes(minutes)) {
    throw new Error("Auto-sync can be off, every 15 minutes, hourly or every 4 hours");
  }
  await loadManagedRow(tx, ctx, migrationId);
  await tx.update(schema.jiraMigration).set({ autoSyncMinutes: minutes, updatedAt: new Date() }).where(eq(schema.jiraMigration.id, migrationId));
}

/**
 * The synced migrations whose auto-sync is due: an interval is set, the migration still has its token, and
 * lastSyncedAt + the interval has passed. Admin connection: a system-wide read across every workspace (the worker
 * starts each one as its creator, in a tenant transaction). The start itself moves the row out of "synced", so a
 * later poll doesn't pick the same migration up again.
 */
export async function findDueJiraAutoSyncs(db: AnyDb, now: Date): Promise<JiraMigrationPublic[]> {
  const rows = await db
    .select()
    .from(schema.jiraMigration)
    .where(
      and(
        eq(schema.jiraMigration.state, "synced"),
        sql`${schema.jiraMigration.autoSyncMinutes} is not null`,
        sql`${schema.jiraMigration.apiTokenEncrypted} is not null`,
        sql`${schema.jiraMigration.lastSyncedAt} is not null`,
        sql`${schema.jiraMigration.lastSyncedAt} + (${schema.jiraMigration.autoSyncMinutes} * interval '1 minute') <= ${now.toISOString()}::timestamptz`,
      ),
    );
  return rows.map(toPublic);
}

/**
 * The project's attachments that are not stored in Kompast (not copied, still
 * queued, or failed), with the JIRA page to open each in. For the CSV the
 * wizard downloads. Any member who can see the project may read it.
 */
export async function listAttachmentsLeftInJira(tx: Tx, ctx: AuthContext, projectId: string): Promise<JiraAttachmentLeftRow[]> {
  await requireProjectAccess(tx, { ...ctx, projectId });
  const rows = await tx
    .select({
      fileName: schema.issueAttachment.fileName,
      sizeBytes: schema.issueAttachment.sizeBytes,
      status: schema.issueAttachment.status,
      error: schema.issueAttachment.error,
      sourceUrl: schema.issueAttachment.sourceUrl,
      sourceId: schema.externalRef.sourceId,
    })
    .from(schema.issueAttachment)
    .innerJoin(schema.issue, eq(schema.issue.id, schema.issueAttachment.issueId))
    .leftJoin(
      schema.externalRef,
      and(eq(schema.externalRef.entityId, schema.issueAttachment.id), eq(schema.externalRef.entityType, "attachment"), eq(schema.externalRef.source, "jira")),
    )
    .where(and(eq(schema.issue.projectId, projectId), inArray(schema.issueAttachment.status, ["not_migrated", "pending", "failed"])))
    .orderBy(asc(schema.issueAttachment.createdAt), asc(schema.issueAttachment.id));
  return rows.map((r) => {
    const slash = r.sourceId ? r.sourceId.lastIndexOf("/") : -1;
    return {
      issueKey: slash >= 0 ? r.sourceId!.slice(0, slash) : "",
      fileName: r.fileName,
      sizeBytes: r.sizeBytes,
      status: r.status as JiraAttachmentLeftRow["status"],
      error: r.error,
      sourceUrl: r.sourceUrl,
    };
  });
}

export interface JiraAttachmentLeftRow {
  issueKey: string;
  fileName: string;
  sizeBytes: number;
  status: "not_migrated" | "pending" | "failed";
  error: string | null;
  sourceUrl: string | null;
}

/**
 * Clears the stored JIRA token, turns auto-sync off, and marks the migration completed. Only from "synced", and only
 * after a reconcile that finished later than the last sync. If that reconcile has unexplained differences, the caller
 * must pass acknowledgedDifferences: true (the user ticked "I've reviewed the differences"). The token is gone from the
 * database once this runs.
 */
export async function finishJiraMigration(tx: Tx, ctx: AuthContext, migrationId: string, opts: { acknowledgedDifferences?: boolean } = {}): Promise<void> {
  const row = await loadManagedRow(tx, ctx, migrationId);
  if (row.state !== "synced") throw new Error(`Only a synced migration can be finished (this one is "${row.state}")`);
  const reconcile = await getLatestJiraReconcile(tx, migrationId);
  const completedAt = reconcile?.completedAt ?? null;
  if (!completedAt || !row.lastSyncedAt || completedAt.getTime() <= row.lastSyncedAt.getTime()) {
    throw new Error("Check completeness after the last sync before finishing");
  }
  const unexplained = unexplainedTotalOf(reconcile!.counts);
  if (unexplained > 0 && opts.acknowledgedDifferences !== true) {
    throw new Error(`${unexplained} differences need a look. Review them, then confirm you have reviewed them.`);
  }
  const now = new Date();
  await tx
    .update(schema.jiraMigration)
    .set({ apiTokenEncrypted: null, tokenClearedAt: now, state: "completed", autoSyncMinutes: null, updatedAt: now })
    .where(eq(schema.jiraMigration.id, migrationId));
}

const DELETABLE_STATE_BLOCKERS = new Set(["discovering", "running"]);

/**
 * Deletes the migration row, token included. Imported issues, sprints,
 * statuses and types stay in the project: this only forgets the link back
 * to JIRA. import_run.migrationId is set to null, so run history survives.
 * Refused while the migration is discovering or running.
 */
export async function deleteJiraMigration(tx: Tx, ctx: AuthContext, migrationId: string): Promise<void> {
  const row = await loadManagedRow(tx, ctx, migrationId);
  if (DELETABLE_STATE_BLOCKERS.has(row.state)) {
    throw new Error(`Cannot delete the migration while it is "${row.state}"`);
  }
  await tx.delete(schema.jiraMigration).where(eq(schema.jiraMigration.id, migrationId));
}

/**
 * Leases up to 2 migrations that need work (discovering or running) whose
 * lease is free or expired. `FOR UPDATE SKIP LOCKED` keeps two worker
 * processes from claiming the same row. Admin connection only: this is a
 * system-wide scan across every workspace, the same exception as
 * claimPendingEmails (packages/db/rls.sql).
 */
/**
 * `onlyIds` scopes the claim to those rows. The worker never passes it (it claims across every workspace); tests
 * do, so parallel test files sharing one database can't lease each other's rows.
 */
export async function claimJiraMigrations(db: AnyDb, leaseMs = JIRA_MIGRATION_LEASE_MS, onlyIds?: string[]): Promise<JiraMigrationPublic[]> {
  const claimed = await db.execute<{ id: string }>(
    sql`update jira_migration
        set lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond')
        where id in (
          select id from jira_migration
          where state in ('discovering', 'running')
            and (lease_expires_at is null or lease_expires_at < now())
            ${onlyIds ? sql`and id in (${sql.join(onlyIds.map((i) => sql`${i}`), sql`, `)})` : sql``}
          order by updated_at
          limit 2
          for update skip locked
        )
        returning id`,
  );
  const ids = claimed.map((r) => r.id);
  if (ids.length === 0) return [];
  const rows = await db.select().from(schema.jiraMigration).where(inArray(schema.jiraMigration.id, ids));
  return rows.map(toPublic);
}

export async function renewJiraMigrationLease(db: AnyDb, migrationId: string, leaseMs = JIRA_MIGRATION_LEASE_MS): Promise<void> {
  await db
    .update(schema.jiraMigration)
    .set({ leaseExpiresAt: sql`now() + (${leaseMs}::int * interval '1 millisecond')` })
    .where(eq(schema.jiraMigration.id, migrationId));
}

export async function releaseJiraMigrationLease(db: AnyDb, migrationId: string): Promise<void> {
  await db.update(schema.jiraMigration).set({ leaseExpiresAt: null }).where(eq(schema.jiraMigration.id, migrationId));
}

/** The decrypted JIRA API token, or null when it was cleared (or never stored). Admin connection only — the worker needs it to call JIRA. */
export async function getJiraMigrationToken(db: AnyDb, migrationId: string): Promise<string | null> {
  const [row] = await db.select({ apiTokenEncrypted: schema.jiraMigration.apiTokenEncrypted }).from(schema.jiraMigration).where(eq(schema.jiraMigration.id, migrationId));
  if (!row?.apiTokenEncrypted) return null;
  return decryptSecret(row.apiTokenEncrypted);
}

/** Stores the discovery snapshot and the suggested mapping, and moves the migration to "ready" for the user to confirm. */
export async function saveJiraDiscovery(tx: Tx, migrationId: string, discovery: Json, mapping: Json): Promise<void> {
  await tx
    .update(schema.jiraMigration)
    .set({ state: "ready", discovery, mapping, error: null, updatedAt: new Date() })
    .where(eq(schema.jiraMigration.id, migrationId));
}

/**
 * A sync's refreshed metadata: the discovery (statuses, types, priorities, fields, sprints, the account's time zone)
 * and the mapping merged with it. Unlike saveJiraDiscovery, the migration keeps its state.
 */
export async function saveJiraSyncMetadata(tx: Tx, migrationId: string, discovery: Json, mapping: Json): Promise<void> {
  await tx.update(schema.jiraMigration).set({ discovery, mapping, updatedAt: new Date() }).where(eq(schema.jiraMigration.id, migrationId));
}

/** Discovery's running count, written on the admin connection while the scan is still going. Does not touch state or updated_at. */
export async function updateJiraMigrationProgress(db: AnyDb, migrationId: string, progress: Json): Promise<void> {
  await db.update(schema.jiraMigration).set({ progress }).where(eq(schema.jiraMigration.id, migrationId));
}

export async function updateJiraMigrationCursor(tx: Tx, migrationId: string, cursor: Json, progress: Json): Promise<void> {
  await tx.update(schema.jiraMigration).set({ cursor, progress, updatedAt: new Date() }).where(eq(schema.jiraMigration.id, migrationId));
}

export async function markJiraMigrationSynced(tx: Tx, migrationId: string, at: Date): Promise<void> {
  await tx
    .update(schema.jiraMigration)
    .set({ state: "synced", lastSyncedAt: at, error: null, updatedAt: new Date() })
    .where(eq(schema.jiraMigration.id, migrationId));
}

/**
 * Sets lastSyncedAt without changing the state. A sync chained into a reconcile still has the reconcile to run, so it
 * stays "running" after its data is in.
 */
export async function setJiraMigrationLastSynced(tx: Tx, migrationId: string, at: Date): Promise<void> {
  await tx.update(schema.jiraMigration).set({ lastSyncedAt: at, error: null, updatedAt: new Date() }).where(eq(schema.jiraMigration.id, migrationId));
}

/**
 * A finished reconcile: back to "synced" with no cursor. lastSyncedAt is untouched, since a reconcile changes no data.
 */
export async function markJiraMigrationIdle(tx: Tx, migrationId: string): Promise<void> {
  await tx
    .update(schema.jiraMigration)
    .set({ state: "synced", cursor: null, progress: null, error: null, updatedAt: new Date() })
    .where(eq(schema.jiraMigration.id, migrationId));
}

/**
 * Typed AnyDb rather than Tx so the runner can fall back to the admin
 * connection when the creator's own tenant transaction is what failed (the
 * creator left the workspace) — the failure still needs recording.
 */
export async function markJiraMigrationFailed(db: AnyDb, migrationId: string, error: string): Promise<void> {
  await db.update(schema.jiraMigration).set({ state: "failed", error, updatedAt: new Date() }).where(eq(schema.jiraMigration.id, migrationId));
}

/**
 * The Kompast key number of each JIRA key the migration imported into this project (external_ref to the issue). Keys
 * that were never imported are left out. For the reconciliation's links: a renumbered issue keeps its JIRA key in
 * the report, and this says which Kompast issue it became.
 */
export async function jiraKeySeqsOf(tx: Tx, projectId: string, keys: string[]): Promise<Record<string, number>> {
  if (keys.length === 0) return {};
  const rows = await tx
    .select({ key: schema.externalRef.sourceId, keySeq: schema.issue.keySeq })
    .from(schema.externalRef)
    .innerJoin(schema.issue, eq(schema.issue.id, schema.externalRef.entityId))
    .where(and(eq(schema.externalRef.source, "jira"), eq(schema.externalRef.entityType, "issue"), eq(schema.issue.projectId, projectId), inArray(schema.externalRef.sourceId, keys)));
  return Object.fromEntries(rows.map((r) => [r.key, r.keySeq]));
}

/** The team and project key a project's board lives under (the same path the sidebar links to). Null when the project is gone. */
export async function getJiraProjectRef(tx: Tx, projectId: string): Promise<{ teamId: string | null; key: string } | null> {
  const [row] = await tx.select({ teamId: schema.project.teamId, key: schema.project.key }).from(schema.project).where(eq(schema.project.id, projectId));
  return row ?? null;
}
