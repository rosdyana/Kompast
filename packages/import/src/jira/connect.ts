import { createJiraClient, JiraApiError, type JiraApiCredentials, type JiraClient } from "./client";
import { pageAgile } from "./discover";

/**
 * The wizard's first step: prove the email and API token work against a JIRA
 * Cloud site, and list what they can see. Read-only; nothing is stored here.
 */

export interface JiraConnectionInfo {
  myself: { accountId: string; displayName: string; emailAddress: string | null };
  /** Every project the token can browse, by name. */
  projects: { id: string; key: string; name: string }[];
}

export interface JiraBoardOption {
  id: number;
  name: string;
  /** JIRA's board type, e.g. "scrum", "kanban" or "simple". */
  type: string;
}

const PROJECT_PAGE_SIZE = 50;
/** A connection check should fail in seconds, not sit through the batch runner's minute-long backoff. One retry covers a blip. */
const CHECK_MAX_ATTEMPTS = 2;
const MYSELF_PATH = "/rest/api/3/myself";

function checkClient(creds: JiraApiCredentials): JiraClient {
  return createJiraClient(creds, { maxAttempts: CHECK_MAX_ATTEMPTS });
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Turns a failed call into the message the wizard shows. Auth rejections and
 * a missing site get their own wording; a network failure names the host.
 * Anything else (including JiraApiError for other statuses) passes through.
 */
function readable(err: unknown, creds: JiraApiCredentials, path: string): unknown {
  if (err instanceof JiraApiError) {
    if (err.status === 401 || err.status === 403) return new Error("JIRA rejected this email and API token.");
    if (err.status === 404 && path === MYSELF_PATH) return new Error("No JIRA Cloud site at this address.");
    return err;
  }
  // fetch() rejects with a TypeError when the host can't be reached at all.
  if (err instanceof TypeError) return new Error(`Couldn't reach ${hostOf(creds.baseUrl)}.`);
  return err;
}

async function call<T>(creds: JiraApiCredentials, path: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw readable(err, creds, path);
  }
}

async function pageProjects(client: JiraClient): Promise<{ id: string; key: string; name: string }[]> {
  const out: { id: string; key: string; name: string }[] = [];
  for (let startAt = 0; ; ) {
    const page = await client.get<{ values?: { id: string; key: string; name: string }[]; isLast?: boolean }>("/rest/api/3/project/search", {
      startAt,
      maxResults: PROJECT_PAGE_SIZE,
    });
    const values = page.values ?? [];
    out.push(...values.map((p) => ({ id: p.id, key: p.key, name: p.name })));
    const done = page.isLast ?? values.length < PROJECT_PAGE_SIZE;
    if (done || values.length === 0) break;
    startAt += values.length;
  }
  return out;
}

/** Who the token belongs to, and the projects it can browse (sorted by name). */
export async function checkJiraConnection(creds: JiraApiCredentials): Promise<JiraConnectionInfo> {
  const client = checkClient(creds);
  const myself = await call(creds, MYSELF_PATH, () =>
    client.get<{ accountId: string; displayName: string; emailAddress?: string }>(MYSELF_PATH),
  );
  const projects = await call(creds, "/rest/api/3/project/search", () => pageProjects(client));
  return {
    myself: { accountId: myself.accountId, displayName: myself.displayName, emailAddress: myself.emailAddress ?? null },
    projects: projects.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The Agile boards that belong to one JIRA project, in JIRA's order. */
export async function listJiraBoards(creds: JiraApiCredentials, projectKey: string): Promise<JiraBoardOption[]> {
  const client = checkClient(creds);
  const path = "/rest/agile/1.0/board";
  const boards = await call(creds, path, () => pageAgile<{ id: number; name: string; type: string }>(client, path, { projectKeyOrId: projectKey }));
  return boards.map((b) => ({ id: b.id, name: b.name, type: b.type }));
}
