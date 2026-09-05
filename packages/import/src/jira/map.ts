import type { JiraStatusCategoryKey } from "./types";

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
