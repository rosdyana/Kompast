import type { NotionBlock, NotionDatabase, NotionPage, NotionSearchResult, NotionUser } from "../notion-api/types";

/**
 * A small fake of the Notion API, keyed by method and path, for the Notion API
 * tests. Lists paginate with start_cursor/page_size like the real API. Failures
 * are injected per "METHOD /v1/path": the next N calls get the given status,
 * then the endpoint works again (N = Infinity keeps failing).
 */
export interface FakeNotionData {
  workspaceName?: string;
  users?: NotionUser[];
  /** Everything search returns, in order. */
  search?: NotionSearchResult[];
  pages?: Record<string, NotionPage>;
  databases?: Record<string, NotionDatabase>;
  /** Children of a page or block, keyed by the parent's id. */
  children?: Record<string, NotionBlock[]>;
  /** The block itself (GET /blocks/:id), for block-parent lookups. */
  blocks?: Record<string, NotionBlock>;
  /** Rows of a data source, keyed by data source id. */
  rows?: Record<string, NotionPage[]>;
  /** Bytes served for a file URL the fake handed out. */
  files?: Record<string, Uint8Array>;
}

export interface FakeNotionOptions {
  /** Requests without this bearer token get 401. */
  token?: string;
  pageSize?: number;
  failures?: Record<string, { status: number; remaining: number; retryAfter?: string }>;
}

export interface FakeNotion {
  fetch: typeof fetch;
  /** Every API call and download, in order, as "METHOD /path" (downloads as "GET <url>"). */
  calls: string[];
  /** Bodies of the search calls, to check what was asked. */
  searchBodies: Record<string, unknown>[];
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function errorBody(status: number, code: string, message: string): unknown {
  return { object: "error", status, code, message };
}

function paginate<T>(items: T[], cursor: string | null, pageSize: number) {
  const start = cursor ? Number(cursor) : 0;
  const end = Math.min(start + pageSize, items.length);
  const hasMore = end < items.length;
  return { object: "list", results: items.slice(start, end), next_cursor: hasMore ? String(end) : null, has_more: hasMore };
}

export function fakeNotion(data: FakeNotionData, options: FakeNotionOptions = {}): FakeNotion {
  const calls: string[] = [];
  const searchBodies: Record<string, unknown>[] = [];
  const pageSize = options.pageSize ?? 100;
  const failures = new Map(Object.entries(options.failures ?? {}).map(([k, v]) => [k, { ...v }]));

  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();

    if (!url.href.startsWith("https://api.notion.com/")) {
      calls.push(`GET ${url.href}`);
      const bytes = data.files?.[url.href];
      if (!bytes) return new Response("not found", { status: 404 });
      return new Response(bytes as unknown as BodyInit, { status: 200, headers: { "content-length": String(bytes.byteLength) } });
    }

    const path = url.pathname.replace(/^\/v1/, "");
    const key = `${method} /v1${path}`;
    calls.push(key);

    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (options.token && auth !== `Bearer ${options.token}`) {
      return json(401, errorBody(401, "unauthorized", "API token is invalid."));
    }
    const failure = failures.get(key);
    if (failure && failure.remaining > 0) {
      failure.remaining--;
      const headers: Record<string, string> = failure.retryAfter ? { "retry-after": failure.retryAfter } : {};
      return json(failure.status, errorBody(failure.status, failure.status === 429 ? "rate_limited" : "internal_server_error", "Injected failure"), headers);
    }

    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const cursor = url.searchParams.get("start_cursor") ?? (typeof body.start_cursor === "string" ? body.start_cursor : null);
    const size = Number(url.searchParams.get("page_size") ?? body.page_size ?? pageSize);
    const pageLimit = Math.min(size, pageSize);

    if (method === "GET" && path === "/users/me") {
      return json(200, { object: "user", id: "bot-1", type: "bot", bot: { workspace_name: data.workspaceName ?? "Test Workspace" } });
    }
    if (method === "GET" && path === "/users") {
      return json(200, paginate(data.users ?? [], cursor, pageLimit));
    }
    if (method === "POST" && path === "/search") {
      searchBodies.push(body);
      return json(200, paginate(data.search ?? [], cursor, pageLimit));
    }
    const pageMatch = /^\/pages\/([^/]+)$/.exec(path);
    if (method === "GET" && pageMatch) {
      const page = data.pages?.[pageMatch[1]!];
      return page ? json(200, page) : json(404, errorBody(404, "object_not_found", "Could not find page."));
    }
    const dbMatch = /^\/databases\/([^/]+)$/.exec(path);
    if (method === "GET" && dbMatch) {
      const db = data.databases?.[dbMatch[1]!];
      return db ? json(200, db) : json(404, errorBody(404, "object_not_found", "Could not find database."));
    }
    const queryMatch = /^\/data_sources\/([^/]+)\/query$/.exec(path);
    if (method === "POST" && queryMatch) {
      return json(200, paginate(data.rows?.[queryMatch[1]!] ?? [], cursor, pageLimit));
    }
    const childrenMatch = /^\/blocks\/([^/]+)\/children$/.exec(path);
    if (method === "GET" && childrenMatch) {
      return json(200, paginate(data.children?.[childrenMatch[1]!] ?? [], cursor, pageLimit));
    }
    const blockMatch = /^\/blocks\/([^/]+)$/.exec(path);
    if (method === "GET" && blockMatch) {
      const block = data.blocks?.[blockMatch[1]!];
      return block ? json(200, block) : json(404, errorBody(404, "object_not_found", "Could not find block."));
    }
    return json(404, errorBody(404, "object_not_found", `No fake route for ${key}`));
  };

  return { fetch: fetchFn as unknown as typeof fetch, calls, searchBodies };
}
