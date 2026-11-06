import type { JiraIssue, JiraSprint, JiraStatusCategoryKey, JiraUser } from "./types";

const SPRINT_STATES = new Set(["closed", "active", "future"]);

function isJiraSprint(v: unknown): v is JiraSprint {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.id === "number" && typeof s.name === "string" && typeof s.state === "string" && SPRINT_STATES.has(s.state.toLowerCase());
}

/**
 * Every sprint an issue has been on, read from whichever field holds
 * sprint objects. The Sprint custom field's id differs per JIRA site, so
 * it's found by shape (an array of {id, name, state}) instead of by name.
 * Also covers the Agile API's `sprint` / `closedSprints` fields that some
 * exports contain. State is lower-cased (some exports send "ACTIVE").
 */
export function extractJiraSprints(issue: JiraIssue): JiraSprint[] {
  const byId = new Map<number, JiraSprint>();
  for (const value of Object.values(issue.fields as unknown as Record<string, unknown>)) {
    const candidates = Array.isArray(value) ? value : isJiraSprint(value) ? [value] : [];
    if (candidates.length === 0 || !candidates.every(isJiraSprint)) continue;
    for (const s of candidates) byId.set(s.id, { ...s, state: s.state.toLowerCase() as JiraSprint["state"] });
  }
  return [...byId.values()];
}

/**
 * The sprint number in a JIRA sprint name — the last run of digits, so
 * "Sprint 42", "PROJ Sprint 42" and "Team A - 42" all give 42. Null when
 * the name has no digits.
 */
export function parseJiraSprintNumber(name: string): number | null {
  const match = name.match(/(\d+)(?!.*\d)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A project priority level as the mapping sees it: `key` is what issue.priority stores. */
export interface PriorityLevelRef {
  key: string;
  name: string;
}

/**
 * JIRA's priority names (lowercased) onto the seeded level keys of a
 * default project (packages/core/src/priority.ts). Only used when the
 * project actually has the target key.
 */
const PRIORITY_SYNONYMS = new Map<string, string>([
  ["highest", "critical"],
  ["blocker", "critical"],
  ["critical", "critical"],
  ["high", "high"],
  ["major", "high"],
  ["medium", "medium"],
  ["normal", "medium"],
  ["low", "low"],
  ["minor", "low"],
  ["lowest", "very_low"],
  ["trivial", "very_low"],
]);

/**
 * The key a JIRA priority name suggests for a project with these levels (in
 * order): (1) a case-insensitive match on a level's name or key, (2) the
 * synonym table, if the key it names exists, (3) the project's "medium" key,
 * else its middle level. A missing name (an issue with no priority) takes (3).
 */
export function suggestPriorityKey(jiraName: string | null | undefined, levels: PriorityLevelRef[]): string {
  const name = (jiraName ?? "").trim().toLowerCase();
  if (name) {
    const byName = levels.find((l) => l.name.toLowerCase() === name || l.key.toLowerCase() === name);
    if (byName) return byName.key;
    const synonym = PRIORITY_SYNONYMS.get(name);
    if (synonym && levels.some((l) => l.key === synonym)) return synonym;
  }
  if (levels.some((l) => l.key === "medium")) return "medium";
  return levels[Math.floor((levels.length - 1) / 2)]?.key ?? "medium";
}

/**
 * The key an issue's JIRA priority is written as: the mapping's choice for
 * that name (case-insensitive) when that key still exists in the project,
 * otherwise the suggestion.
 */
export function resolvePriorityKey(jiraName: string | null | undefined, levels: PriorityLevelRef[], mapped: { jiraName: string; kompastKey: string }[]): string {
  const name = (jiraName ?? "").toLowerCase();
  const entry = name ? mapped.find((p) => p.jiraName.toLowerCase() === name) : undefined;
  if (entry && levels.some((l) => l.key === entry.kompastKey)) return entry.kompastKey;
  return suggestPriorityKey(jiraName, levels);
}

/**
 * The seeded key for a JIRA priority name, with no project in view. The
 * loader and the suggestion resolve against the project's real levels instead
 * (suggestPriorityKey); this stays for callers that only have the name.
 */
export function mapJiraPriority(name: string | undefined | null): string {
  const key = (name ?? "").trim().toLowerCase();
  return PRIORITY_SYNONYMS.get(key) ?? "medium";
}

/**
 * JIRA's own status category IS the ground truth here (see plan: "JIRA's
 * own category is the input, but a human confirms the mapping in the
 * dry-run report") — trusted directly, not re-derived from the status
 * name. "indeterminate" is JIRA's real category key for "in progress",
 * not a typo.
 */
export function mapJiraStatusCategory(key: JiraStatusCategoryKey): "todo" | "in_progress" | "done" {
  if (key === "new") return "todo";
  if (key === "done") return "done";
  return "in_progress";
}

/**
 * Every distinct email address across reporter/assignee/comment-authors/
 * worklog-authors in a batch of issues — the caller (e.g. the REST
 * endpoint) resolves each once via its own email->Kompast-user lookup
 * (a DB query, so it can't happen inside runJiraImport's synchronous
 * resolveUserId) and builds the Map that callback closes over. Avoids
 * resolving the same prolific commenter's email dozens of times.
 */
export function collectJiraEmails(issues: JiraIssue[]): string[] {
  const emails = new Set<string>();
  const add = (u: JiraUser | null | undefined) => {
    if (u?.emailAddress) emails.add(u.emailAddress.toLowerCase());
  };
  for (const issue of issues) {
    add(issue.fields.reporter);
    add(issue.fields.assignee);
    for (const c of issue.fields.comment?.comments ?? []) add(c.author);
    for (const w of issue.fields.worklog?.worklogs ?? []) add(w.author);
  }
  return [...emails];
}
