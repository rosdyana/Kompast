import type { JiraIssue, JiraStatusCategoryKey, JiraUser } from "./types";

const PRIORITY_MAP: Record<string, "lowest" | "low" | "medium" | "high" | "highest"> = {
  highest: "highest",
  high: "high",
  medium: "medium",
  low: "low",
  lowest: "lowest",
};

export function mapJiraPriority(name: string | undefined | null): "lowest" | "low" | "medium" | "high" | "highest" {
  if (!name) return "medium";
  return PRIORITY_MAP[name.toLowerCase()] ?? "medium";
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
