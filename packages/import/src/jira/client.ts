export interface JiraApiCredentials {
  /** e.g. "https://your-site.atlassian.net" — no trailing slash. */
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface JiraClientOptions {
  /** Defaults to the global fetch, looked up at call time (so a test's vi.stubGlobal("fetch") is honoured). */
  fetch?: typeof fetch;
  /** Defaults to a real setTimeout. Injected by tests so retry waits are asserted, not slept. */
  sleep?: (ms: number) => Promise<void>;
  /** How many requests may be in flight at once. JIRA Cloud rate-limits per site, so the default stays small. */
  maxConcurrency?: number;
  /** Total tries per request, including the first. Retries stop at this count and the last error is thrown. */
  maxAttempts?: number;
}

/** A non-2xx JIRA response. The message keeps JIRA's error body verbatim, so callers and tests can match on it. */
export class JiraApiError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`JIRA API error (${status}): ${body}`);
    this.name = "JiraApiError";
    this.status = status;
    this.body = body;
  }
}

export interface JiraClient {
  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  /** Raw GET returning the Response (for attachment bytes later). */
  getRaw(url: string): Promise<Response>;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_MAX_CONCURRENCY = 4;

/** Exponential backoff for a 1-based attempt number: 1s, 2s, 4s, ... capped at 60s. */
function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/** Retry-After in seconds (the form JIRA sends). Null when absent or not a plain number (an HTTP-date form falls back to backoff). */
function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/** A tiny counting semaphore. Slots are handed directly to the next waiter on release, so the limit holds even when a slot frees up while another caller is arriving. */
class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/**
 * The one place that talks HTTP to JIRA. Basic auth with email:apiToken;
 * retries 429/502/503/504 and network errors (honouring Retry-After, else
 * exponential backoff); caps in-flight requests; throws JiraApiError for
 * anything else non-2xx. Retries and the concurrency slot both live here so
 * every caller (discovery, the batched runner, attachments) gets them.
 */
export function createJiraClient(creds: JiraApiCredentials, opts: JiraClientOptions = {}): JiraClient {
  const fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> =
    opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const limiter = new Semaphore(opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  const authorization = `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64")}`;

  async function send(url: string | URL, init: { method: string; accept: string; contentType?: string; body?: string }): Promise<Response> {
    const headers: Record<string, string> = { authorization, accept: init.accept };
    if (init.contentType) headers["content-type"] = init.contentType;

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await limiter.run(() => fetchImpl(url, { method: init.method, headers, body: init.body }));
      } catch (err) {
        if (attempt >= maxAttempts) throw err;
        await sleep(backoffMs(attempt));
        continue;
      }

      if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts) {
        const waitMs = retryAfterMs(res);
        await res.text().catch(() => "");
        await sleep(waitMs ?? backoffMs(attempt));
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new JiraApiError(res.status, body);
      }
      return res;
    }
  }

  function siteUrl(path: string, params?: Record<string, string | number | undefined>): URL {
    const url = new URL(path, creds.baseUrl);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  return {
    async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
      const res = await send(siteUrl(path, params), { method: "GET", accept: "application/json" });
      return (await res.json()) as T;
    },

    async post<T>(path: string, body: unknown): Promise<T> {
      const res = await send(siteUrl(path), {
        method: "POST",
        accept: "application/json",
        contentType: "application/json",
        body: JSON.stringify(body),
      });
      return (await res.json()) as T;
    },

    getRaw(url: string): Promise<Response> {
      return send(url, { method: "GET", accept: "*/*" });
    },
  };
}
