import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { loadEnv } from "@kompast/env";
import { clientIp, isRateLimited, rateLimit, tooManyRequests, __setRateLimitRedisForTests } from "../rate-limit";

// Real Redis (REDIS_URL from .env.local.dev). Every test uses its own random key so files and tests can't collide.
const redis = new Redis(loadEnv().REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
const created: string[] = [];
function freshKey(name: string) {
  const key = `test:${name}:${randomUUID()}`;
  created.push(key);
  return key;
}

afterAll(async () => {
  if (created.length) await redis.del(created.map((k) => `rl:${k}`));
  await redis.quit();
});

describe("rateLimit", () => {
  it("allows up to the limit in a window, then blocks the next call with a Retry-After", async () => {
    const key = freshKey("block");
    for (let i = 0; i < 3; i++) expect(await rateLimit(key, 3, 60)).toMatchObject({ ok: true, retryAfter: 0 });

    const blocked = await rateLimit(key, 3, 60);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(blocked.retryAfter).toBeLessThanOrEqual(60);
  });

  it("gives the window a TTL on first use, so the key can't live forever", async () => {
    const key = freshKey("ttl");
    await rateLimit(key, 5, 120);
    const ttl = await redis.ttl(`rl:${key}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it("isRateLimited reads the counter without incrementing it", async () => {
    const key = freshKey("peek");
    expect(await isRateLimited(key, 2, 60)).toEqual({ limited: false, retryAfter: 0 });

    await rateLimit(key, 2, 60);
    await rateLimit(key, 2, 60);
    for (let i = 0; i < 5; i++) {
      const gate = await isRateLimited(key, 2, 60);
      expect(gate.limited).toBe(true);
      expect(gate.retryAfter).toBeGreaterThan(0);
    }
    expect(await redis.get(`rl:${key}`)).toBe("2");
  });

  it("fails open when Redis is unreachable: requests are allowed and nothing throws", async () => {
    const unreachable = new Redis("redis://127.0.0.1:1", { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 500 });
    unreachable.on("error", () => {});
    __setRateLimitRedisForTests(unreachable);
    try {
      expect(await rateLimit("unreachable-key", 1, 60)).toEqual({ ok: true, retryAfter: 0 });
      expect(await rateLimit("unreachable-key", 1, 60)).toEqual({ ok: true, retryAfter: 0 });
      expect(await isRateLimited("unreachable-key", 1, 60)).toEqual({ limited: false, retryAfter: 0 });
    } finally {
      __setRateLimitRedisForTests(undefined);
      unreachable.disconnect();
    }
  });
});

describe("clientIp", () => {
  it("uses the first X-Forwarded-For entry, and 'unknown' when the header is absent", () => {
    expect(clientIp(new Request("http://x/", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } }))).toBe("203.0.113.7");
    expect(clientIp(new Request("http://x/"))).toBe("unknown");
  });
});

describe("tooManyRequests", () => {
  it("is a 429 problem+json with Retry-After", async () => {
    const res = tooManyRequests(42);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ type: "about:blank", title: "Too Many Requests", status: 429 });
  });
});
