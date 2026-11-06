import { JiraApiError, type JiraClient } from "./client";
import { collectsOptions, optionValuesOf, sampleText } from "./fields";
import { fetchJiraIssuePage } from "./extract";
import { extractJiraSprints, parseJiraSprintNumber } from "./map";
import type { JiraIssue, JiraSprint, JiraUser } from "./types";

/**
 * Read-only survey of one JIRA project, run before any migration writes
 * anything. Everything here is plain JSON so it can sit in
 * jira_migration.discovery and be shown to the user as-is.
 */
export interface JiraDiscoveredBoard {
  id: number;
  name: string;
  type: string;
}

export interface JiraDiscoveredPerson {
  accountId: string;
  displayName: string;
  emailAddress: string | null;
  active: boolean;
  accountType: string;
  /** How many issues this person was on (reporter, assignee, creator, or a comment author). */
  touches: number;
  /** Highest sprint number on any issue this person touched. Null when none of those issues had a numbered sprint. */
  lastSprintNumber: number | null;
}

export interface JiraDiscoveredField {
  id: string;
  name: string;
  custom: boolean;
  schemaType: string | null;
  schemaItems: string | null;
  schemaCustom: string | null;
}

export interface JiraDiscovery {
  scannedAt: string;
  /** The account the token belongs to. `timeZone` is the account's JIRA time zone: JQL dates are read in it (see sync.ts). Absent on a discovery from before it was stored. */
  myself: { accountId: string; displayName: string; emailAddress: string | null; timeZone?: string | null };
  project: { id: string; key: string; name: string };
  boards: JiraDiscoveredBoard[];
  /** The board the sprint list came from: the requested one, else the project's first board. Null when the project has none. */
  board: JiraDiscoveredBoard | null;
  /** Board sprints (including empty future ones) merged with any sprint seen on an issue, deduped by id. */
  sprints: JiraSprint[];
  statuses: { name: string; categoryKey: string }[];
  issueTypes: { name: string; subtask: boolean }[];
  priorities: { name: string }[];
  fields: JiraDiscoveredField[];
  issueCount: number;
  minKeyNumber: number | null;
  maxKeyNumber: number | null;
  /** Per field id: how many issues had that field non-empty (not null, "", or []). */
  fieldUsage: Record<string, number>;
  /**
   * Per option-like field id (see fields.ts's collectsOptions): its distinct values, most used first, with how many
   * issues had each (capped at 300 values per field). A child option reads "parent / child". Absent on a discovery from before this was collected.
   */
  fieldOptions?: Record<string, { value: string; count: number }[]>;
  /** Per used field id: up to three sample values as short plain text (see fields.ts's sampleText). Absent on a discovery from before this was collected. */
  fieldSamples?: Record<string, string[]>;
  people: JiraDiscoveredPerson[];
  attachmentCount: number;
  attachmentSizes: number[];
  commentCount: number;
  worklogCount: number;
}

export interface DiscoverJiraProjectOptions {
  projectKey: string;
  boardId?: number;
  onProgress?: (scanned: number) => void;
}

const AGILE_PAGE_SIZE = 50;
const SPRINT_BOARD_TYPES = new Set(["scrum", "simple"]);
const MAX_SCAN_PAGES = 1000;
/** Distinct option values kept per field. A field with more keeps its first ones, and the loader adds the rest lazily. */
const MAX_OPTIONS_PER_FIELD = 300;
/** Sample values kept per used field. */
const MAX_SAMPLES_PER_FIELD = 3;

interface RawSprint {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  goal?: string;
  originBoardId?: number;
}

/** Walks an Agile API list endpoint (`{ values, isLast }`) to the end. */
export async function pageAgile<T>(client: JiraClient, path: string, params: Record<string, string | number | undefined>): Promise<T[]> {
  const out: T[] = [];
  for (let startAt = 0; ; ) {
    const page = await client.get<{ values?: T[]; isLast?: boolean }>(path, { ...params, startAt, maxResults: AGILE_PAGE_SIZE });
    const values = page.values ?? [];
    out.push(...values);
    const done = page.isLast ?? values.length < AGILE_PAGE_SIZE;
    if (done || values.length === 0) break;
    startAt += values.length;
  }
  return out;
}

function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function keyNumber(key: string): number | null {
  const match = /-(\d+)$/.exec(key);
  return match ? Number(match[1]) : null;
}

/** The project's metadata, read without scanning its issues: who the token is, the project, its boards and sprints, statuses, issue types, priorities and fields. */
export interface JiraDiscoveryMetadata {
  myself: JiraDiscovery["myself"];
  project: JiraDiscovery["project"];
  boards: JiraDiscoveredBoard[];
  board: JiraDiscoveredBoard | null;
  /** The board's sprints (including empty future ones), by id. */
  sprints: JiraSprint[];
  statuses: { name: string; categoryKey: string }[];
  issueTypes: { name: string; subtask: boolean }[];
  priorities: { name: string }[];
  fields: JiraDiscoveredField[];
}

/**
 * The metadata part of a survey: a few GET requests, no issue scan. A catch-up sync refreshes it before reading
 * changed issues, so statuses, types, priorities, fields and sprints JIRA added since the last run are known first.
 */
export async function discoverJiraMetadata(client: JiraClient, opts: { projectKey: string; boardId?: number }): Promise<JiraDiscoveryMetadata> {
  const key = opts.projectKey;

  const myself = await client.get<{ accountId: string; displayName: string; emailAddress?: string; timeZone?: string }>("/rest/api/3/myself");
  const project = await client.get<{ id: string; key: string; name: string }>(`/rest/api/3/project/${encodeURIComponent(key)}`);

  const boards = await pageAgile<JiraDiscoveredBoard>(client, "/rest/agile/1.0/board", { projectKeyOrId: key });
  let board: JiraDiscoveredBoard | null;
  if (opts.boardId !== undefined) {
    board = boards.find((b) => b.id === opts.boardId) ?? null;
    if (!board) throw new Error(`JIRA board ${opts.boardId} does not belong to project ${key}`);
  } else {
    board = boards[0] ?? null;
  }

  const sprintsById = new Map<number, JiraSprint>();
  if (board && SPRINT_BOARD_TYPES.has(board.type)) {
    try {
      const boardSprints = await pageAgile<RawSprint>(client, `/rest/agile/1.0/board/${board.id}/sprint`, {});
      for (const s of boardSprints) {
        sprintsById.set(s.id, {
          id: s.id,
          name: s.name,
          state: s.state.toLowerCase() as JiraSprint["state"],
          boardId: s.originBoardId,
          goal: s.goal,
          startDate: s.startDate,
          endDate: s.endDate,
          completeDate: s.completeDate,
        });
      }
    } catch (err) {
      if (!(err instanceof JiraApiError && err.status === 400)) throw err;
    }
  }

  const statusRows = await client.get<{ name: string; subtask?: boolean; statuses: { name: string; statusCategory?: { key: string } }[] }[]>(
    `/rest/api/3/project/${encodeURIComponent(key)}/statuses`,
  );
  const statusByName = new Map<string, { name: string; categoryKey: string }>();
  const issueTypeByName = new Map<string, { name: string; subtask: boolean }>();
  for (const issueType of statusRows) {
    if (!issueTypeByName.has(issueType.name)) issueTypeByName.set(issueType.name, { name: issueType.name, subtask: !!issueType.subtask });
    for (const s of issueType.statuses ?? []) {
      if (!statusByName.has(s.name)) statusByName.set(s.name, { name: s.name, categoryKey: s.statusCategory?.key ?? "indeterminate" });
    }
  }

  const priorities = (await client.get<{ name: string }[]>("/rest/api/3/priority")).map((p) => ({ name: p.name }));

  const rawFields = await client.get<
    { id: string; name: string; custom?: boolean; schema?: { type?: string; items?: string; custom?: string } }[]
  >("/rest/api/3/field");
  const fields: JiraDiscoveredField[] = rawFields.map((f) => ({
    id: f.id,
    name: f.name,
    custom: !!f.custom,
    schemaType: f.schema?.type ?? null,
    schemaItems: f.schema?.items ?? null,
    schemaCustom: f.schema?.custom ?? null,
  }));

  return {
    myself: { accountId: myself.accountId, displayName: myself.displayName, emailAddress: myself.emailAddress ?? null, ...(myself.timeZone ? { timeZone: myself.timeZone } : {}) },
    project: { id: project.id, key: project.key, name: project.name },
    boards,
    board,
    sprints: [...sprintsById.values()].sort((a, b) => a.id - b.id),
    statuses: [...statusByName.values()],
    issueTypes: [...issueTypeByName.values()],
    priorities,
    fields,
  };
}

/**
 * Surveys a JIRA project: who the token belongs to, the project's boards and
 * sprints, its statuses, issue types, priorities and fields, and a full scan
 * of its issues (counts, field usage, people, attachment sizes). Makes many
 * GET requests and writes nothing. The client handles retries and pacing.
 */
export async function discoverJiraProject(client: JiraClient, opts: DiscoverJiraProjectOptions): Promise<JiraDiscovery> {
  const key = opts.projectKey;
  const meta = await discoverJiraMetadata(client, { projectKey: key, boardId: opts.boardId });
  const sprintsById = new Map<number, JiraSprint>(meta.sprints.map((s) => [s.id, s]));
  const { statuses: statusList, issueTypes: issueTypeList, priorities, fields } = meta;
  const fieldShapes = new Map(fields.map((f) => [f.id, f]));

  const jql = `project = "${key.replace(/"/g, '\\"')}" ORDER BY key ASC`;
  const fieldUsage = new Map<string, number>();
  const optionCounts = new Map<string, Map<string, number>>();
  const samples = new Map<string, string[]>();
  const people = new Map<string, JiraDiscoveredPerson>();
  const attachmentSizes: number[] = [];
  let issueCount = 0;
  let minKeyNumber: number | null = null;
  let maxKeyNumber: number | null = null;
  let commentCount = 0;
  let worklogCount = 0;

  const notePerson = (user: JiraUser, issueSprintNumber: number | null) => {
    let person = people.get(user.accountId);
    if (!person) {
      person = {
        accountId: user.accountId,
        displayName: user.displayName,
        emailAddress: user.emailAddress ?? null,
        active: user.active !== false,
        accountType: user.accountType ?? "unknown",
        touches: 0,
        lastSprintNumber: null,
      };
      people.set(user.accountId, person);
    }
    if (!person.emailAddress && user.emailAddress) person.emailAddress = user.emailAddress;
    person.touches++;
    if (issueSprintNumber !== null && (person.lastSprintNumber === null || issueSprintNumber > person.lastSprintNumber)) {
      person.lastSprintNumber = issueSprintNumber;
    }
  };

  /** One issue's distinct option values for a field: each counts once per issue, and new values stop at the cap. */
  const countOptions = (fieldId: string, values: string[]) => {
    let counts = optionCounts.get(fieldId);
    if (!counts) {
      counts = new Map();
      optionCounts.set(fieldId, counts);
    }
    for (const v of values) {
      const seen = counts.get(v);
      if (seen !== undefined) counts.set(v, seen + 1);
      else if (counts.size < MAX_OPTIONS_PER_FIELD) counts.set(v, 1);
    }
  };
  const noteSample = (fieldId: string, value: unknown) => {
    const list = samples.get(fieldId) ?? [];
    if (list.length >= MAX_SAMPLES_PER_FIELD) return;
    const text = sampleText(value);
    if (!text || list.includes(text)) return;
    list.push(text);
    samples.set(fieldId, list);
  };

  const absorbIssue = (issue: JiraIssue) => {
    issueCount++;
    const n = keyNumber(issue.key);
    if (n !== null) {
      minKeyNumber = minKeyNumber === null ? n : Math.min(minKeyNumber, n);
      maxKeyNumber = maxKeyNumber === null ? n : Math.max(maxKeyNumber, n);
    }

    for (const [fieldId, value] of Object.entries(issue.fields as unknown as Record<string, unknown>)) {
      if (!isNonEmpty(value)) continue;
      fieldUsage.set(fieldId, (fieldUsage.get(fieldId) ?? 0) + 1);
      const shape = fieldShapes.get(fieldId);
      if (shape && collectsOptions(shape)) countOptions(fieldId, optionValuesOf(value));
      noteSample(fieldId, value);
    }

    const sprints = extractJiraSprints(issue);
    for (const s of sprints) if (!sprintsById.has(s.id)) sprintsById.set(s.id, s);
    const sprintNumbers = sprints.map((s) => parseJiraSprintNumber(s.name)).filter((n): n is number => n !== null);
    const issueSprintNumber = sprintNumbers.length ? Math.max(...sprintNumbers) : null;

    const involved = new Map<string, JiraUser>();
    const addUser = (u: JiraUser | null | undefined) => {
      if (u?.accountId && !involved.has(u.accountId)) involved.set(u.accountId, u);
    };
    addUser(issue.fields.reporter);
    addUser(issue.fields.assignee);
    addUser(issue.fields.creator);
    for (const c of issue.fields.comment?.comments ?? []) addUser(c.author);
    for (const user of involved.values()) notePerson(user, issueSprintNumber);

    for (const a of issue.fields.attachment ?? []) attachmentSizes.push(a.size);
    commentCount += issue.fields.comment?.total ?? issue.fields.comment?.comments?.length ?? 0;
    worklogCount += issue.fields.worklog?.total ?? issue.fields.worklog?.worklogs?.length ?? 0;
  };

  let token: string | undefined;
  for (let pages = 0; pages < MAX_SCAN_PAGES; pages++) {
    const page = await fetchJiraIssuePage(client, jql, { nextPageToken: token, fields: "*all", maxResults: 100 });
    for (const issue of page.issues) absorbIssue(issue);
    opts.onProgress?.(issueCount);
    if (page.isLast || !page.nextPageToken || page.issues.length === 0) break;
    token = page.nextPageToken;
  }

  return {
    scannedAt: new Date().toISOString(),
    myself: meta.myself,
    project: meta.project,
    boards: meta.boards,
    board: meta.board,
    sprints: [...sprintsById.values()].sort((a, b) => a.id - b.id),
    statuses: statusList,
    issueTypes: issueTypeList,
    priorities,
    fields,
    issueCount,
    minKeyNumber,
    maxKeyNumber,
    fieldUsage: Object.fromEntries(fieldUsage),
    fieldOptions: Object.fromEntries(
      [...optionCounts].map(([fieldId, counts]) => [
        fieldId,
        [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
      ]),
    ),
    fieldSamples: Object.fromEntries(samples),
    people: [...people.values()].sort((a, b) => b.touches - a.touches || a.displayName.localeCompare(b.displayName)),
    attachmentCount: attachmentSizes.length,
    attachmentSizes,
    commentCount,
    worklogCount,
  };
}
