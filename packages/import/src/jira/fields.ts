import type { IssuePropertyType, JiraCoreField } from "@kompast/core";
import { adfToPlainText } from "./adf";
import type { JiraUser } from "./types";

/**
 * JIRA custom and system fields: what each one is (handled by the loader, not
 * migratable, or a choice the user makes), and how a JIRA value becomes a
 * Kompast property value. The discovery, the mapping suggestion and the loader
 * all read these rules, so they live here once.
 */

/** The shape of one discovered JIRA field, as far as the field rules read it. */
export interface JiraFieldShape {
  id: string;
  name: string;
  custom: boolean;
  schemaType: string | null;
  schemaItems: string | null;
  schemaCustom: string | null;
}

/**
 * JIRA's system fields the loader already writes: core columns, history,
 * comments, links, or customFields.jira. fixVersions and components are in
 * here too, but they're also offered as fields when used (see FIELDS_OFFERED).
 */
export const JIRA_HANDLED_FIELD_IDS: ReadonlySet<string> = new Set([
  "summary",
  "description",
  "issuetype",
  "status",
  "statusCategory",
  "statuscategorychangedate",
  "priority",
  "assignee",
  "reporter",
  "creator",
  "labels",
  "parent",
  "subtasks",
  "issuelinks",
  "comment",
  "worklog",
  "attachment",
  "watches",
  "votes",
  "created",
  "updated",
  "resolution",
  "resolutiondate",
  "duedate",
  "timeoriginalestimate",
  "timespent",
  "progress",
  "workratio",
  "timetracking",
  "project",
  "issuerestriction",
  "lastViewed",
  "fixVersions",
  "components",
]);

/** Handled fields that are still offered as a choice when they're used: their values are also kept in customFields.jira. */
const FIELDS_OFFERED: ReadonlySet<string> = new Set(["fixVersions", "components"]);

/** Why a field is not a choice: its values can't be migrated, or it's skipped by default. */
export type JiraFieldReason = "board-colour" | "app-computed" | "dev-tool-summary" | "agent-sessions" | "any-type" | "unsupported-type";

/** The core field each core target writes, and its Kompast type. */
export const JIRA_CORE_FIELD_TYPE: Record<JiraCoreField, IssuePropertyType> = {
  storyPoints: "number",
  estimateSeconds: "number",
  startDate: "date",
  dueDate: "date",
};

/** A seconds value (JIRA's time estimates) written as hours. */
export const SECONDS_TO_HOURS = "secondsToHours" as const;

/** A field the loader already handles (or that Kompast's sprint and rank logic owns): not a choice. */
export function isHandledJiraField(f: JiraFieldShape): boolean {
  if (FIELDS_OFFERED.has(f.id)) return false;
  if (JIRA_HANDLED_FIELD_IDS.has(f.id) || f.id.startsWith("aggregate")) return true;
  const custom = f.schemaCustom ?? "";
  return custom.endsWith(":gh-sprint") || custom.endsWith(":gh-lexo-rank");
}

/** Which fields carry a set of options whose values the discovery counts (see discover.ts). */
export function collectsOptions(f: JiraFieldShape): boolean {
  const type = f.schemaType ?? "";
  const items = f.schemaItems ?? "";
  if (type === "option" || type === "option-with-child") return true;
  if (type === "array") return items === "option" || items === "version" || items === "component" || (items === "string" && f.custom);
  return false;
}

export type JiraFieldClassification =
  | { kind: "handled" }
  | { kind: "notMigratable"; reason: JiraFieldReason }
  | { kind: "skip"; reason: JiraFieldReason }
  | {
      kind: "migrate";
      /** A core field this one should fill, when nothing with more usage has claimed it. */
      coreCandidate?: JiraCoreField;
      /** The new property this field becomes when it isn't a core candidate, or the core one is taken. */
      create: { name: string; type: IssuePropertyType };
      transform?: "secondsToHours";
      /** JIRA's person field holds a list: the first value is taken. */
      firstValueOnly?: boolean;
    };

/**
 * What a field is, from its schema. `optionValues` are the field's distinct
 * option values (from discovery): a multi-option field whose only option is
 * "Impediment" becomes a checkbox.
 */
export function classifyJiraField(f: JiraFieldShape, optionValues: string[] = []): JiraFieldClassification {
  if (isHandledJiraField(f)) return { kind: "handled" };

  const custom = f.schemaCustom ?? "";
  const type = f.schemaType ?? "";
  const items = f.schemaItems ?? "";
  const name = f.name.trim();

  if (custom.includes("devsummarycf")) return { kind: "notMigratable", reason: "dev-tool-summary" };
  if (custom.includes("agent-sessions")) return { kind: "notMigratable", reason: "agent-sessions" };
  if (type === "any") return { kind: "notMigratable", reason: "any-type" };

  if (custom.endsWith(":jsw-issue-color")) return { kind: "skip", reason: "board-colour" };
  if (f.custom && (custom.includes("forge") || /^checklist progress/i.test(name))) return { kind: "skip", reason: "app-computed" };

  if (custom.endsWith(":jsw-story-points") || /^story (points|point estimate)$/i.test(name)) {
    return { kind: "migrate", coreCandidate: "storyPoints", create: { name: f.name, type: "number" } };
  }
  if (f.id === "timeestimate") {
    return { kind: "migrate", create: { name: "Remaining estimate (h)", type: "number" }, transform: SECONDS_TO_HOURS };
  }
  if (custom.endsWith(":datepicker") && /^start date$/i.test(name)) {
    return { kind: "migrate", coreCandidate: "startDate", create: { name: f.name, type: "date" } };
  }

  const named = (t: IssuePropertyType): JiraFieldClassification => ({ kind: "migrate", create: { name: f.name, type: t } });
  switch (type) {
    case "number":
      return named("number");
    case "date":
    case "datetime":
      return named("date");
    case "string":
      return named(custom.endsWith(":textarea") ? "textarea" : custom.endsWith(":url") ? "url" : "text");
    case "option":
    case "option-with-child":
      return named("select");
    case "user":
      return { kind: "migrate", create: { name: f.name, type: "person" } };
    case "array":
      if (items === "user") return { kind: "migrate", create: { name: f.name, type: "person" }, firstValueOnly: true };
      if (items === "option" && optionValues.length === 1 && optionValues[0] === "Impediment") return named("checkbox");
      if (items === "option" || items === "string" || items === "version" || items === "component") return named("multiSelect");
      return { kind: "skip", reason: "unsupported-type" };
    default:
      return { kind: "skip", reason: "unsupported-type" };
  }
}

// ── Discovery helpers ───────────────────────────────────────────────────────

/** Samples are cut to this many characters. */
export const SAMPLE_MAX_CHARS = 80;

/** The option text one option-like value holds: `value`, a child option as "parent / child", or a version/component's name. */
function optionTextOf(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { value?: unknown; name?: unknown; child?: unknown };
  if (typeof o.value === "string") {
    const child = o.child && typeof o.child === "object" ? optionTextOf(o.child) : null;
    return child ? `${o.value} / ${child}` : o.value;
  }
  if (typeof o.name === "string") return o.name;
  return null;
}

/** The distinct option values one field value holds (for a list, each element). */
export function optionValuesOf(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      if (v) out.push(v);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    const text = optionTextOf(v);
    if (text) out.push(text);
  };
  visit(value);
  return [...new Set(out)];
}

/** A field value as one line of text, for the wizard's samples. Null when there's nothing to show. */
function plainTextOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(plainTextOf).filter((p): p is string => p !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    const o = value as { type?: unknown; accountId?: unknown; displayName?: unknown };
    if (o.type === "doc") return adfToPlainText(value).trim() || null;
    if (typeof o.accountId === "string") return typeof o.displayName === "string" ? o.displayName : o.accountId;
    const option = optionTextOf(value);
    if (option) return option;
    return JSON.stringify(value);
  }
  return null;
}

/** A field value as a short sample for the wizard: plain text, cut to SAMPLE_MAX_CHARS. Null when empty. */
export function sampleText(value: unknown): string | null {
  const text = plainTextOf(value);
  if (!text) return null;
  return text.length > SAMPLE_MAX_CHARS ? `${text.slice(0, SAMPLE_MAX_CHARS - 1)}…` : text;
}

// ── Value conversion ────────────────────────────────────────────────────────

export type JiraValueConversion =
  | { kind: "empty" }
  /** A person who has no Kompast user (neither a mapped member nor a former-member placeholder). */
  | { kind: "unresolved" }
  | { kind: "value"; value: string | number | boolean | string[] }
  | { kind: "error"; message: string };

export interface JiraValueOptions {
  /** secondsToHours divides a number by 3600. */
  transform?: typeof SECONDS_TO_HOURS;
  /** Maps a JIRA user to a Kompast user id, or null. Only a person target asks. */
  resolveUser?: (user: JiraUser) => string | null;
}

/** JIRA's empty values: null, a blank string, an empty list. */
export function isEmptyJiraValue(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === "string") return raw.trim() === "";
  if (Array.isArray(raw)) return raw.length === 0;
  return false;
}

function numberOf(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** One option's text for a single-choice property. A list of one is that one; a longer list has no single answer. */
function singleOptionOf(raw: unknown): string | null | undefined {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.length === 1 ? singleOptionOf(raw[0]) : undefined;
  return optionTextOf(raw);
}

/** Text for a text, textarea or url property. */
function textOf(raw: unknown): string | null {
  return plainTextOf(raw);
}

/**
 * Converts one JIRA field value into the stored value a Kompast property of
 * `type` holds (the formats the issue-detail editor reads and writes):
 * number, date as YYYY-MM-DD, checkbox true, text, one option's value, a list
 * of option values, or a user id. Never throws: a value it can't represent
 * comes back as an error the loader reports against the field.
 */
export function convertJiraValue(raw: unknown, type: IssuePropertyType, opts: JiraValueOptions = {}): JiraValueConversion {
  if (isEmptyJiraValue(raw)) return { kind: "empty" };

  switch (type) {
    case "number": {
      const n = numberOf(raw);
      if (n === null) return { kind: "error", message: "not a number" };
      return { kind: "value", value: opts.transform === SECONDS_TO_HOURS ? Math.round((n / 3600) * 100) / 100 : n };
    }
    case "date": {
      const match = typeof raw === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim()) : null;
      if (!match || Number.isNaN(Date.parse(match[1]!))) return { kind: "error", message: "not a date" };
      return { kind: "value", value: match[1]! };
    }
    case "checkbox":
      if (typeof raw === "boolean") return raw ? { kind: "value", value: true } : { kind: "empty" };
      return { kind: "value", value: true };
    case "text":
    case "textarea":
    case "url": {
      const text = textOf(raw);
      return text ? { kind: "value", value: text } : { kind: "empty" };
    }
    case "select": {
      const text = singleOptionOf(raw);
      if (text === undefined) return { kind: "error", message: "holds several values, but this property takes one" };
      if (!text) return { kind: "error", message: "unsupported value" };
      return { kind: "value", value: text };
    }
    case "multiSelect": {
      const items = Array.isArray(raw) ? raw : [raw];
      const values = [...new Set(items.map((o) => (typeof o === "string" ? o : optionTextOf(o))).filter((v): v is string => !!v))];
      return values.length > 0 ? { kind: "value", value: values } : { kind: "empty" };
    }
    case "person": {
      const user = Array.isArray(raw) ? raw[0] : raw;
      if (!user || typeof user !== "object" || typeof (user as JiraUser).accountId !== "string") {
        return { kind: "error", message: "no person in the value" };
      }
      const userId = opts.resolveUser?.(user as JiraUser) ?? null;
      return userId ? { kind: "value", value: userId } : { kind: "unresolved" };
    }
    default:
      return { kind: "error", message: `unsupported property type ${type}` };
  }
}
