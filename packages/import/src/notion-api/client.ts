import type { NotionBlock, NotionDatabase, NotionList, NotionPage, NotionSearchResult, NotionUser } from "./types";

/**
 * A thin client for the Notion API: throttled to Notion's ~3 requests/second
 * average, retries 429, server errors and dropped connections, gives each request
 * a timeout, and maps failures to NotionApiError.
 * Takes its fetch and sleep as options so tests drive it without a network.
 */

export const NOTION_API_BASE = "https://api.notion.com/v1";
export const NOTION_VERSION = "2026-03-11";
/** Gap between request starts. Notion averages 3 requests/second, so 340 ms keeps a margin under it. */
export const DEFAULT_MIN_INTERVAL_MS = 340;
/** Retries after the first attempt, for 429, 500/502/503/504, a dropped connection, and a timeout. */
export const MAX_RETRIES = 4;
/** An API request that takes longer than this is aborted and retried. A hung connection would otherwise stall the tick. */
export const REQUEST_TIMEOUT_MS = 60_000;
/** A file download gets longer: up to DEFAULT_MAX_DOWNLOAD_BYTES on a slow link. */
export const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/** Retries after the first attempt for a download's dropped connection or timeout. */
const DOWNLOAD_RETRIES = 2;
/** Largest file the importer will download, matching the storage upload cap (packages/storage's MAX_UPLOAD_BYTES). */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const PAGE_SIZE = 100;

export class NotionApiError extends Error {
  readonly status: number;
  /** Notion's error code (`unauthorized`, `object_not_found`, ...), or `http_<status>` when the body had none. */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "NotionApiError";
    this.status = status;
    this.code = code;
  }
}

export interface NotionClientOptions {
  token: string;
  fetch?: typeof fetch;
  /** Defaults to a real setTimeout. Tests inject one that advances a fake clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to Date.now. */
  now?: () => number;
  minIntervalMs?: number;
  /** Defaults to REQUEST_TIMEOUT_MS / DOWNLOAD_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

export interface NotionClient {
  me(): Promise<NotionUser>;
  listUsers(cursor?: string | null): Promise<NotionList<NotionUser>>;
  search(cursor?: string | null): Promise<NotionList<NotionSearchResult>>;
  getDatabase(id: string): Promise<NotionDatabase>;
  getPage(id: string): Promise<NotionPage>;
  queryDataSource(id: string, cursor?: string | null): Promise<NotionList<NotionPage>>;
  getBlock(id: string): Promise<NotionBlock>;
  listBlockChildren(id: string, cursor?: string | null): Promise<NotionList<NotionBlock>>;
  /** Downloads a file from a URL Notion handed out (no auth header: these are signed storage URLs). Throws past maxBytes. */
  download(url: string, maxBytes?: number): Promise<Uint8Array>;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Milliseconds to wait before a retry: Retry-After (seconds) when Notion sent one, else exponential backoff. */
function retryDelayMs(retryAfter: string | null, attempt: number): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return 1000 * 2 ** attempt;
}

/**
 * A failure of the connection itself, worth another try: undici's fetch throws a
 * TypeError ("fetch failed", "terminated") for a reset or dropped connection, and
 * AbortSignal.timeout aborts with a TimeoutError.
 */
function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function errorFrom(status: number, text: string): NotionApiError {
  let code = `http_${status}`;
  let message = `Notion API returned HTTP ${status}`;
  try {
    const body = JSON.parse(text) as { code?: unknown; message?: unknown } | null;
    if (body && typeof body.code === "string" && body.code) code = body.code;
    if (body && typeof body.message === "string" && body.message) message = body.message;
  } catch {
    // Not JSON: keep the HTTP-status message.
  }
  if (status === 401) code = "unauthorized";
  return new NotionApiError(status, code, message);
}

export function createNotionClient(options: NotionClientOptions): NotionClient {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? (() => Date.now());
  const minInterval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const requestTimeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const downloadTimeout = options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  let lastRequestAt: number | null = null;

  async function throttle(): Promise<void> {
    if (lastRequestAt === null) return;
    const wait = lastRequestAt + minInterval - now();
    if (wait > 0) await sleep(wait);
  }

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await throttle();
      lastRequestAt = now();
      let res: Response;
      let text: string;
      try {
        res = await fetchFn(`${NOTION_API_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${options.token}`,
            "Notion-Version": NOTION_VERSION,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(requestTimeout),
        });
        if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
          await sleep(retryDelayMs(res.headers.get("retry-after"), attempt));
          continue;
        }
        // Read inside the try: the connection can drop mid-body too.
        text = await res.text();
      } catch (err) {
        if (isNetworkError(err) && attempt < MAX_RETRIES) {
          await sleep(retryDelayMs(null, attempt));
          continue;
        }
        throw err;
      }
      if (!res.ok) throw errorFrom(res.status, text);
      return JSON.parse(text) as T;
    }
  }

  function withCursor(path: string, cursor: string | null | undefined): string {
    return cursor ? `${path}&start_cursor=${encodeURIComponent(cursor)}` : path;
  }

  return {
    me: () => request<NotionUser>("GET", "/users/me"),
    listUsers: (cursor) => request<NotionList<NotionUser>>("GET", withCursor(`/users?page_size=${PAGE_SIZE}`, cursor)),
    search: (cursor) => {
      const body: Record<string, unknown> = { page_size: PAGE_SIZE };
      if (cursor) body.start_cursor = cursor;
      return request<NotionList<NotionSearchResult>>("POST", "/search", body);
    },
    getDatabase: (id) => request<NotionDatabase>("GET", `/databases/${encodeURIComponent(id)}`),
    getPage: (id) => request<NotionPage>("GET", `/pages/${encodeURIComponent(id)}`),
    queryDataSource: (id, cursor) => {
      const body: Record<string, unknown> = { page_size: PAGE_SIZE };
      if (cursor) body.start_cursor = cursor;
      return request<NotionList<NotionPage>>("POST", `/data_sources/${encodeURIComponent(id)}/query`, body);
    },
    getBlock: (id) => request<NotionBlock>("GET", `/blocks/${encodeURIComponent(id)}`),
    listBlockChildren: (id, cursor) =>
      request<NotionList<NotionBlock>>("GET", withCursor(`/blocks/${encodeURIComponent(id)}/children?page_size=${PAGE_SIZE}`, cursor)),
    async download(url, maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES) {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetchFn(url, { signal: AbortSignal.timeout(downloadTimeout) });
          if (!res.ok) throw new NotionApiError(res.status, `download_${res.status}`, `A file could not be downloaded from Notion (HTTP ${res.status})`);
          const declared = Number(res.headers.get("content-length") ?? NaN);
          if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`File is larger than ${maxBytes} bytes`);
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (bytes.byteLength > maxBytes) throw new Error(`File is larger than ${maxBytes} bytes`);
          return bytes;
        } catch (err) {
          if (isNetworkError(err) && attempt < DOWNLOAD_RETRIES) {
            await sleep(retryDelayMs(null, attempt));
            continue;
          }
          throw err;
        }
      }
    },
  };
}
