import Redis from "ioredis";
import { loadEnv } from "@kompast/env";

/**
 * Fixed-window rate limits in the same Redis the worker uses. Fails open: if
 * Redis is unreachable, requests go through and a warning is logged (at most
 * once a minute). A Redis outage shouldn't lock every user out of the app.
 */

const KEY_PREFIX = "rl:";
const WARN_INTERVAL_MS = 60_000;

let client: Redis | undefined;
let lastWarnAt = 0;

function getClient(): Redis {
  client ??= new Redis(loadEnv().REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    // Commands sent while disconnected fail at once instead of queueing, so a Redis outage can't stall requests.
    enableOfflineQueue: false,
    connectTimeout: 2000,
  });
  return client;
}

/** Connects a lazy client before the first command, since with the offline queue off that command would otherwise fail. */
async function ready(): Promise<Redis> {
  const redis = getClient();
  if (redis.status === "wait") await redis.connect().catch(() => undefined);
  return redis;
}

/** Tests only: point the limiter at a specific Redis (or pass undefined to go back to the configured one). */
export function __setRateLimitRedisForTests(redis: Redis | undefined): void {
  client = redis;
}

async function retryAfterFor(redis: Redis, key: string, windowSeconds: number): Promise<number> {
  const ttl = await redis.ttl(key);
  return ttl > 0 ? ttl : windowSeconds;
}

function warnFailOpen(err: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  console.warn("[rate-limit] Redis unavailable, allowing request:", err instanceof Error ? err.message : err);
}

/** Counts one hit against `key` and reports whether it's still within `limit` for the current window. */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<{ ok: boolean; retryAfter: number }> {
  try {
    const redis = await ready();
    const k = KEY_PREFIX + key;
    const count = await redis.incr(k);
    // NX only sets the expiry if none is set, so every hit re-arms a missing TTL without extending the window.
    await redis.expire(k, windowSeconds, "NX");
    if (count <= limit) return { ok: true, retryAfter: 0 };
    return { ok: false, retryAfter: await retryAfterFor(redis, k, windowSeconds) };
  } catch (err) {
    warnFailOpen(err);
    return { ok: true, retryAfter: 0 };
  }
}

/**
 * Checks the counter without incrementing it, for gates that should only
 * count failures (e.g. bad tokens): a gate reads, the failing path calls rateLimit.
 */
export async function isRateLimited(key: string, limit: number, windowSeconds: number): Promise<{ limited: boolean; retryAfter: number }> {
  try {
    const redis = await ready();
    const k = KEY_PREFIX + key;
    const count = Number((await redis.get(k)) ?? 0);
    if (count < limit) return { limited: false, retryAfter: 0 };
    return { limited: true, retryAfter: await retryAfterFor(redis, k, windowSeconds) };
  } catch (err) {
    warnFailOpen(err);
    return { limited: false, retryAfter: 0 };
  }
}

/**
 * The caller's IP for a rate-limit key: the first X-Forwarded-For entry, the
 * same trust model as auth.ts's ipAddressHeaders. In the documented
 * topology every service binds 127.0.0.1 behind Caddy, and Caddy (2.5+)
 * ignores a client-sent X-Forwarded-For unless `trusted_proxies` is set,
 * writing the real peer address instead — so the first entry is Caddy's.
 * Behind a different proxy that appends to a client-supplied header, the
 * first entry is spoofable; configure that proxy to overwrite it.
 */
export function clientIp(request: Request): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || "unknown";
}

/** RFC 9457 problem+json 429, same shape as every other API error, with Retry-After so clients can back off. */
export function tooManyRequests(retryAfter: number): Response {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      detail: `Too many requests. Try again in ${retryAfter} seconds.`,
    }),
    { status: 429, headers: { "Content-Type": "application/problem+json", "Retry-After": String(retryAfter) } },
  );
}
