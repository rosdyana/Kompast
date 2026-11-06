import type { JiraIssue } from "./types";
import { createJiraClient, type JiraApiCredentials, type JiraClient } from "./client";

export type { JiraApiCredentials } from "./client";

const PAGE_SIZE = 100;

/** Hard stop so a misbehaving server that keeps returning a token can't loop forever (100 × 1000 = 100k issues). */
const MAX_PAGES = 1000;

export interface JiraIssuePage {
  issues: JiraIssue[];
  /** Absent on the last page. Pass back as `nextPageToken` to fetch the next one. */
  nextPageToken?: string;
  isLast: boolean;
}

export interface JiraIssuePageOptions {
  nextPageToken?: string;
  /** Defaults to `*all` — the importer wants every field (comments, worklogs, attachments, the Sprint custom field). */
  fields?: string;
  /** e.g. "changelog". Omitted by default, so discovery's scan stays light. */
  expand?: string;
  maxResults?: number;
}

/**
 * One page of JIRA Cloud's enhanced search endpoint
 * (`GET /rest/api/3/search/jql`). The old `GET /rest/api/3/search` now returns
 * 410 Gone (Atlassian CHANGE-2046). The new endpoint pages with an opaque
 * `nextPageToken` and returns no `total`.
 */
export async function fetchJiraIssuePage(client: JiraClient, jql: string, opts: JiraIssuePageOptions = {}): Promise<JiraIssuePage> {
  const page = await client.get<{ issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>("/rest/api/3/search/jql", {
    jql,
    maxResults: opts.maxResults ?? PAGE_SIZE,
    fields: opts.fields ?? "*all",
    expand: opts.expand,
    nextPageToken: opts.nextPageToken,
  });
  const nextPageToken = page.nextPageToken || undefined;
  return { issues: page.issues ?? [], nextPageToken, isLast: page.isLast ?? !nextPageToken };
}

/**
 * Pulls every issue matching `jql`, following `nextPageToken` until `isLast`
 * (or no token comes back). `fields=*all` and `expand=changelog` are always
 * requested: the importer wants comments, worklogs, attachments, changelog and
 * the Sprint custom field in one pass, and the Sprint field's id differs per site.
 */
export async function fetchJiraIssues(creds: JiraApiCredentials, jql: string): Promise<JiraIssue[]> {
  const client = createJiraClient(creds);
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;

  for (let pageCount = 0; pageCount < MAX_PAGES; pageCount++) {
    const page = await fetchJiraIssuePage(client, jql, { nextPageToken, fields: "*all", expand: "changelog", maxResults: PAGE_SIZE });
    issues.push(...page.issues);

    if (page.isLast || !page.nextPageToken || page.issues.length === 0) break;
    nextPageToken = page.nextPageToken;
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
