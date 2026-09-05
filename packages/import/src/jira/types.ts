/**
 * A deliberate SUBSET of JIRA Cloud REST API v3's real issue shape
 * (`GET /rest/api/3/search`, `expand=changelog`) — only the fields this
 * importer actually maps. Anything else in a real response is ignored,
 * not an error (unknown fields on a JSON object are simply not read).
 */
export interface JiraUser {
  accountId: string;
  emailAddress?: string;
  displayName: string;
}

export type JiraStatusCategoryKey = "new" | "indeterminate" | "done";

export interface JiraStatus {
  name: string;
  statusCategory: { key: JiraStatusCategoryKey; name: string };
}

export interface JiraIssueTypeRef {
  name: string;
  subtask: boolean;
}

/** `body` is either a plain string (older API versions/CSV exports) or an Atlassian Document Format node tree — see adf.ts. */
export interface JiraComment {
  id: string;
  author: JiraUser | null;
  body: unknown;
  created: string;
}

export interface JiraWorklogEntry {
  id: string;
  author: JiraUser | null;
  timeSpentSeconds: number;
  started: string;
  comment?: unknown;
}

export interface JiraChangelogItem {
  field: string;
  fromString: string | null;
  toString: string | null;
}

export interface JiraChangelogHistory {
  created: string;
  items: JiraChangelogItem[];
}

export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** URL to GET the actual bytes from (same auth as the search API) — never embedded inline. */
  content: string;
}

export interface JiraIssueLink {
  type: { name: string };
  /** Present when this issue is the "blocks"/"relates to" source of the link. */
  outwardIssue?: { key: string };
  /** Present when this issue is the target — i.e. some other issue points at this one. */
  inwardIssue?: { key: string };
}

export interface JiraIssueFields {
  summary: string;
  issuetype: JiraIssueTypeRef;
  status: JiraStatus;
  assignee: JiraUser | null;
  reporter: JiraUser | null;
  priority: { name: string } | null;
  labels: string[];
  description: unknown;
  /** Subtasks' parent (and, in team-managed projects only, sometimes an epic parent) — see load.ts for the documented limitation on classic-project epic links. */
  parent?: { key: string };
  fixVersions?: { name: string }[];
  components?: { name: string }[];
  timeoriginalestimate?: number | null;
  timespent?: number | null;
  duedate?: string | null;
  created: string;
  comment?: { comments: JiraComment[] };
  worklog?: { worklogs: JiraWorklogEntry[] };
  attachment?: JiraAttachment[];
  issuelinks?: JiraIssueLink[];
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: JiraIssueFields;
  changelog?: { histories: JiraChangelogHistory[] };
}
