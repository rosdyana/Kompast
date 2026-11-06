import type { JiraCoreField, JiraFieldMapping, JiraMappingTargets, JiraMigrationMapping, JiraStatusCategory } from "@kompast/core";
import type { JiraDiscovery } from "./discover";
import { classifyJiraField } from "./fields";
import { mapJiraStatusCategory, suggestPriorityKey } from "./map";
import type { JiraStatusCategoryKey } from "./types";

/**
 * What the user confirms before a migration runs: how each JIRA status,
 * issue type, person and field maps onto Kompast. Stored in jira_migration.mapping.
 *
 * The shape lives in @kompast/core (core validates it on save, and core
 * cannot import this package), so it's re-exported here for the importer.
 */
export type { JiraMigrationMapping, JiraStatusColumnPlacement, JiraStatusCategory, JiraFieldMapping, JiraCoreField } from "@kompast/core";

/** Attachments above this size are skipped by default. */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** What the suggestion and the merge may point at. Core's listJiraMappingTargets returns a superset. */
export type KompastMappingTargets = Pick<JiraMappingTargets, "statuses" | "types" | "members" | "columns" | "priorities" | "properties">;

/** Lowercase, `_` read as a space, and every non-letter/non-digit stripped — so "jeff5_lin" and "Jeff5 Lin" compare equal. */
function normalizeName(name: string): string {
  return name.replace(/_/g, " ").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

type ColumnTarget = KompastMappingTargets["columns"][number];

/**
 * Where a status of the given category should land by default, so the
 * board reads in workflow order: to-do statuses after the last to-do column,
 * in-progress ones after the last to-do or in-progress column (before the
 * first done column), done ones after the last column. A column's category is
 * that of its first status in workflow order. Null = the start of the board.
 */
function suggestPlacement(category: JiraStatusCategory, kompast: KompastMappingTargets): NonNullable<JiraMigrationMapping["statuses"][number]["column"]> {
  // kompast.statuses is in workflow order, so the first match is the first status in workflow order.
  const categoryOf = (column: ColumnTarget): JiraStatusCategory | null => kompast.statuses.find((s) => column.statusIds.includes(s.id))?.category ?? null;
  const columns = [...kompast.columns].sort((a, b) => a.order - b.order);
  const categories = columns.map((c) => ({ column: c, category: categoryOf(c) }));

  let anchor: ColumnTarget | undefined;
  if (category === "todo") {
    anchor = categories.filter((c) => c.category === "todo").at(-1)?.column;
  } else if (category === "in_progress") {
    anchor = categories.filter((c) => c.category === "todo" || c.category === "in_progress").at(-1)?.column;
  } else {
    anchor = columns.at(-1);
  }
  return { mode: "new", afterColumnId: anchor?.id ?? null };
}

/**
 * Suggests the default mapping for a discovered JIRA project. Statuses and
 * types match by case-insensitive name, else they're created (a created
 * status gets a suggested column placement, see suggestPlacement). People
 * match by email first, then by normalized display name (only when exactly
 * one member has that name, so an ambiguous name never guesses). Anyone
 * unmatched is "former" (no Kompast account). Each JIRA priority suggests a
 * level of the project (suggestPriorityKey). Nothing is written. The user
 * can change any entry before the run starts.
 */
export function suggestJiraMapping(discovery: JiraDiscovery, kompast: KompastMappingTargets): JiraMigrationMapping {
  const statusByName = new Map(kompast.statuses.map((s) => [s.name.toLowerCase(), s]));
  const typeByName = new Map(kompast.types.map((t) => [t.name.toLowerCase(), t]));

  const statuses: JiraMigrationMapping["statuses"] = discovery.statuses.map((s) => {
    const existing = statusByName.get(s.name.toLowerCase());
    if (existing) return { jiraName: s.name, category: existing.category, action: "map", kompastStatusId: existing.id };
    const category = mapJiraStatusCategory(s.categoryKey as JiraStatusCategoryKey);
    return { jiraName: s.name, category, action: "create", column: suggestPlacement(category, kompast) };
  });

  const types: JiraMigrationMapping["types"] = discovery.issueTypes.map((t) => {
    const existing = typeByName.get(t.name.toLowerCase());
    if (existing) return { jiraName: t.name, action: "map", kompastTypeId: existing.id };
    return { jiraName: t.name, action: "create" };
  });

  const people: JiraMigrationMapping["people"] = suggestPeopleMapping(discovery.people, kompast.members);

  const priorities: JiraMigrationMapping["priorities"] = (discovery.priorities ?? []).map((p) => ({
    jiraName: p.name,
    kompastKey: suggestPriorityKey(p.name, kompast.priorities),
  }));

  const fields = suggestFieldMappings(discovery, kompast.properties ?? []);

  return { statuses, types, people, priorities, attachmentMaxBytes: DEFAULT_ATTACHMENT_MAX_BYTES, fields };
}

/**
 * The suggested entry for each JIRA person: a member matched by email, else by normalized display name (only when
 * exactly one member has that name, so an ambiguous name never guesses), else "former". Used for a new survey and,
 * by a sync, for people a changed issue brings that the mapping doesn't have yet.
 */
export function suggestPeopleMapping(
  people: { accountId: string; displayName: string; emailAddress: string | null }[],
  members: KompastMappingTargets["members"],
): JiraMigrationMapping["people"] {
  const byEmail = new Map<string, KompastMappingTargets["members"][number]>();
  const byNormalizedName = new Map<string, KompastMappingTargets["members"][number][]>();
  for (const m of members) {
    if (m.email) byEmail.set(m.email.toLowerCase(), m);
    const n = normalizeName(m.name);
    byNormalizedName.set(n, [...(byNormalizedName.get(n) ?? []), m]);
  }

  return people.map((p) => {
    const byMail = p.emailAddress ? byEmail.get(p.emailAddress.toLowerCase()) : undefined;
    if (byMail) return { accountId: p.accountId, displayName: p.displayName, action: "map", kompastUserId: byMail.userId, confidence: "email" };

    const byName = byNormalizedName.get(normalizeName(p.displayName)) ?? [];
    if (byName.length === 1) return { accountId: p.accountId, displayName: p.displayName, action: "map", kompastUserId: byName[0]!.userId, confidence: "name" };

    return { accountId: p.accountId, displayName: p.displayName, action: "former", confidence: "none" };
  });

}

/** Property types a JIRA field's inferred type may reuse in place of: text-like ones are interchangeable. */
const TEXT_LIKE: ReadonlySet<string> = new Set(["text", "textarea", "url"]);

function compatibleProperty(existingType: string, createType: string): boolean {
  return existingType === createType || (TEXT_LIKE.has(existingType) && TEXT_LIKE.has(createType));
}

/**
 * The suggested choice for every used JIRA field the loader doesn't handle
 * itself (fields.ts's classifyJiraField). Usage order decides a core target:
 * the most-used field that claims it gets it, the others become properties.
 * A custom property with the same name (case-insensitive) and a compatible type
 * is reused. Skipped and unmigratable fields are only ever reported, never
 * written, so an unmigratable one isn't in this list at all.
 */
export function suggestFieldMappings(discovery: JiraDiscovery, properties: NonNullable<KompastMappingTargets["properties"]>): JiraFieldMapping[] {
  const usage = discovery.fieldUsage ?? {};
  const optionsOf = discovery.fieldOptions ?? {};
  const candidates = (discovery.fields ?? [])
    .filter((f) => (usage[f.id] ?? 0) > 0)
    .map((f) => ({ field: f, usage: usage[f.id]!, classification: classifyJiraField(f, (optionsOf[f.id] ?? []).map((o) => o.value)) }))
    .filter((c) => c.classification.kind === "migrate" || c.classification.kind === "skip")
    .sort((a, b) => b.usage - a.usage || a.field.name.localeCompare(b.field.name));

  const claimed = new Set<JiraCoreField>();
  return candidates.map(({ field, classification }): JiraFieldMapping => {
    const base = { jiraFieldId: field.id, jiraName: field.name };
    if (classification.kind !== "migrate") return { ...base, action: "skip" };

    if (classification.coreCandidate && !claimed.has(classification.coreCandidate)) {
      claimed.add(classification.coreCandidate);
      return { ...base, action: "core", coreField: classification.coreCandidate };
    }

    const { create, transform } = classification;
    const existing = properties.find((p) => !p.isCore && p.name.trim().toLowerCase() === create.name.trim().toLowerCase() && compatibleProperty(p.type, create.type));
    if (existing) return { ...base, action: "property", propertyKey: existing.key, ...(transform && existing.type === "number" ? { transform } : {}) };
    return { ...base, action: "property", create: { name: create.name, type: create.type }, ...(transform && create.type === "number" ? { transform } : {}) };
  });
}

/**
 * The merge a re-scan uses: the new suggestion, except that an entry the user
 * already chose is kept when its JIRA name (statuses, types: case-insensitive)
 * or account id (people) is still in JIRA AND the Kompast row it points at
 * still exists (a column placement too, for created statuses). Otherwise the
 * suggestion wins. New JIRA entries get the suggestion; entries gone from JIRA
 * are dropped. A priority choice is kept while its level still exists in the
 * project. The attachment limit is the user's, so it's kept as-is.
 */
export function mergeJiraMapping(previous: JiraMigrationMapping, suggested: JiraMigrationMapping, kompast: KompastMappingTargets): JiraMigrationMapping {
  const statusIds = new Set(kompast.statuses.map((s) => s.id));
  const typeIds = new Set(kompast.types.map((t) => t.id));
  const memberIds = new Set(kompast.members.map((m) => m.userId));
  const columnIds = new Set(kompast.columns.map((c) => c.id));
  const priorityKeys = new Set(kompast.priorities.map((p) => p.key));

  const prevStatus = new Map(previous.statuses.map((s) => [s.jiraName.toLowerCase(), s]));
  const prevType = new Map(previous.types.map((t) => [t.jiraName.toLowerCase(), t]));
  const prevPerson = new Map(previous.people.map((p) => [p.accountId, p]));
  const prevPriority = new Map((previous.priorities ?? []).map((p) => [p.jiraName.toLowerCase(), p]));

  const statuses = suggested.statuses.map((s) => {
    const prev = prevStatus.get(s.jiraName.toLowerCase());
    if (!prev) return s;
    if (prev.action === "map") return prev.kompastStatusId && statusIds.has(prev.kompastStatusId) ? prev : s;
    const placement = prev.column;
    const placementOk =
      !placement || (placement.mode === "new" ? placement.afterColumnId === null || columnIds.has(placement.afterColumnId) : columnIds.has(placement.columnId));
    return placementOk ? prev : s;
  });

  const types = suggested.types.map((t) => {
    const prev = prevType.get(t.jiraName.toLowerCase());
    if (!prev) return t;
    if (prev.action === "map") return prev.kompastTypeId && typeIds.has(prev.kompastTypeId) ? prev : t;
    return prev;
  });

  const people = suggested.people.map((p) => {
    const prev = prevPerson.get(p.accountId);
    if (!prev) return p;
    if (prev.action === "former") return prev;
    return prev.kompastUserId && memberIds.has(prev.kompastUserId) ? prev : p;
  });

  const priorities = suggested.priorities.map((p) => {
    const prev = prevPriority.get(p.jiraName.toLowerCase());
    return prev && priorityKeys.has(prev.kompastKey) ? prev : p;
  });

  // Fields: the suggestion's list is the base (fields gone from JIRA drop out). A kept entry is the user's
  // choice, unless it pointed at a property that no longer exists. A core target is claimed once; a
  // second claim (a new field that now wants it) falls back to skip, which the user can change.
  const customKeys = new Set((kompast.properties ?? []).filter((p) => !p.isCore).map((p) => p.key));
  const prevField = new Map((previous.fields ?? []).map((f) => [f.jiraFieldId, f]));
  const claimedCore = new Set<JiraCoreField>();
  const fields = (suggested.fields ?? []).map((s): JiraFieldMapping => {
    const prev = prevField.get(s.jiraFieldId);
    let chosen: JiraFieldMapping = s;
    if (prev) {
      const stillValid = prev.action !== "property" || prev.create !== undefined || (prev.propertyKey !== undefined && customKeys.has(prev.propertyKey));
      chosen = stillValid ? prev : s;
    }
    if (chosen.action === "core" && chosen.coreField) {
      if (claimedCore.has(chosen.coreField)) return { jiraFieldId: chosen.jiraFieldId, jiraName: chosen.jiraName, action: "skip" };
      claimedCore.add(chosen.coreField);
    }
    return chosen;
  });

  return { statuses, types, people, priorities, attachmentMaxBytes: previous.attachmentMaxBytes, fields };
}
