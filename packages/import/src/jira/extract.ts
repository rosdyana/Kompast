import type { JiraIssue } from "./types";

export interface JiraApiCredentials {
  /** e.g. "https://your-site.atlassian.net" — no trailing slash. */
  baseUrl: string;
  email: string;
  apiToken: string;
}

const PAGE_SIZE = 100;

/**
 * Pulls every issue matching `jql` from JIRA Cloud's real REST API v3
 * search endpoint (`GET /rest/api/3/search`), paginating via
 * startAt/maxResults until `total` is exhausted. `expand=changelog` and
 * `fields=*all` are always requested — this importer wants everything
 * (worklogs, comments, attachments, changelog) in one pass rather than a
 * field allowlist, since which fields matter depends on what's actually
 * present per issue.
 */
export async function fetchJiraIssues(creds: JiraApiCredentials, jql: string): Promise<JiraIssue[]> {
  const auth = Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64");
  const issues: JiraIssue[] = [];
  let startAt = 0;

  while (true) {
    const url = new URL("/rest/api/3/search", creds.baseUrl);
    url.searchParams.set("jql", jql);
    url.searchParams.set("startAt", String(startAt));
    url.searchParams.set("maxResults", String(PAGE_SIZE));
    url.searchParams.set("fields", "*all");
    url.searchParams.set("expand", "changelog");

    const res = await fetch(url, { headers: { authorization: `Basic ${auth}`, accept: "application/json" } });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`JIRA API error (${res.status}): ${detail}`);
    }
    const page = (await res.json()) as { startAt: number; maxResults: number; total: number; issues: JiraIssue[] };
    issues.push(...page.issues);

    startAt += page.issues.length;
    if (page.issues.length === 0 || startAt >= page.total) break;
  }

  return issues;
}

/**
 * Fallback extraction path — a checked-out JSON export (the same shape
 * `fetchJiraIssues` returns, or a raw `{issues: [...]}` search-response
 * blob) with no live API call. See plan: "source: REST API (Cloud or
 * Data Center) with a CSV/JSON export fallback."
 */
export function parseJiraExportFile(json: unknown): JiraIssue[] {
  if (Array.isArray(json)) return json as JiraIssue[];
  if (json && typeof json === "object" && Array.isArray((json as { issues?: unknown }).issues)) {
    return (json as { issues: JiraIssue[] }).issues;
  }
  throw new Error("Unrecognized JIRA export shape — expected an issue array or a {issues: [...]} search response");
}
