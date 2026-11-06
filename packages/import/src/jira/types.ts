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
  /** Present on user objects embedded in issue fields (not on every response shape). */
  active?: boolean;
  accountType?: string;
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
  /** Last edit time. The imported comment's updated_at, so a sync can tell whether JIRA has a newer body. */
  updated?: string;
  /** JIRA's HTML rendering of body. Present only on responses requested with expand=renderedBody (enrich.ts). */
  renderedBody?: string;
}

export interface JiraWorklogEntry {
  id: string;
  author: JiraUser | null;
  timeSpentSeconds: number;
  started: string;
  comment?: unknown;
  /** Last edit time. Present on JIRA's worklog objects. */
  updated?: string;
}

export interface JiraChangelogItem {
  /** The field's display name ("status", "assignee", "Sprint", "Story point estimate" ...). */
  field: string;
  /** The field's id ("status", "customfield_10016" ...). Present on JIRA's changelog items. */
  fieldId?: string;
  /** Raw values: account ids for assignee, sprint ids (comma-separated) for Sprint, ids for status/priority. */
  from?: string | null;
  to?: string | null;
  fromString: string | null;
  toString: string | null;
}

export interface JiraChangelogHistory {
  id?: string;
  created: string;
  /** Who made the change. Present on JIRA's changelog. Absent on a search response that doesn't carry it. */
  author?: JiraUser | null;
  items: JiraChangelogItem[];
}

export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** URL to GET the actual bytes from (same auth as the search API) — never embedded inline. */
  content: string;
  /** When JIRA received the file. Becomes the placeholder's created time in a migration. */
  created?: string;
  /** Who uploaded the file. Resolved through the people mapping, so a former member is still credited. */
  author?: JiraUser | null;
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
  creator?: JiraUser | null;
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
  /** `total` is JIRA's real comment count; `comments` is only the first page JIRA embeds in a search response. */
  comment?: { comments: JiraComment[]; total?: number };
  /** Same as comment: `total` is the real count, `worklogs` is the embedded first page. */
  worklog?: { worklogs: JiraWorklogEntry[]; total?: number };
  attachment?: JiraAttachment[];
  issuelinks?: JiraIssueLink[];
  /** Last update time. Becomes the imported issue's updatedAt, so the import doesn't stamp every issue with "now". */
  updated?: string;
  /** When the issue was resolved. null/absent when it isn't. Becomes issue.resolved_at. */
  resolutiondate?: string | null;
  resolution?: { name: string } | null;
  /** Watcher count from JIRA. Only `watchCount > 0` needs a follow-up call for the list (see enrich.ts). */
  watches?: { watchCount: number; isWatching?: boolean };
}

/**
 * One entry of JIRA Software's Sprint custom field (schema custom type
 * `com.pyxis.greenhopper.jira:gh-sprint`). Its field id differs per site
 * (often customfield_10020), so the loader finds it by shape — see
 * map.ts's extractJiraSprints. The field lists EVERY sprint the issue has
 * been on, including closed ones it was carried out of.
 */
export interface JiraSprint {
  id: number;
  name: string;
  state: "closed" | "active" | "future";
  boardId?: number;
  goal?: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: JiraIssueFields;
  /** `total` > histories.length means the embedded list is only a first page (see enrich.ts). */
  changelog?: { histories: JiraChangelogHistory[]; total?: number };
  /** Filled by enrich.ts from GET /issue/{key}/watchers when watches.watchCount > 0. Absent otherwise. */
  watchersList?: JiraUser[];
}
