import { describe, expect, it } from "vitest";
import { createNotionClient, NotionApiError } from "../notion-api/client";
import { fakeNotion } from "./notion-api-fake";

/** A clock the tests advance: sleep moves it forward, requests record when they started. */
function fakeClock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

describe("Notion API client", () => {
  it("sends the token and the pinned Notion-Version on every request", async () => {
    const seen: Record<string, string>[] = [];
    const fake = fakeNotion({ workspaceName: "Acme" }, { token: "ntn_good" });
    const wrapped: typeof fetch = async (input, init) => {
      seen.push(init?.headers as Record<string, string>);
      return fake.fetch(input, init);
    };
    const client = createNotionClient({ token: "ntn_good", fetch: wrapped, sleep: async () => {} });
    const me = await client.me();
    expect(me.bot?.workspace_name).toBe("Acme");
    expect(seen[0]).toMatchObject({ Authorization: "Bearer ntn_good", "Notion-Version": "2026-03-11" });
  });

  it("spaces request starts at least minIntervalMs apart", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const fake = fakeNotion({ workspaceName: "Acme" });
    const timed: typeof fetch = async (input, init) => {
      starts.push(clock.now());
      return fake.fetch(input, init);
    };
    const client = createNotionClient({ token: "t", fetch: timed, sleep: clock.sleep, now: clock.now, minIntervalMs: 340 });
    await client.me();
    await client.me();
    await client.me();
    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(340);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(340);
    // The throttle sleeps only for the gap still owed, never the whole interval up front.
    expect(clock.sleeps.every((ms) => ms > 0 && ms <= 340)).toBe(true);
  });

  it("waits the Retry-After seconds on a 429, then retries and succeeds", async () => {
    const clock = fakeClock();
    const fake = fakeNotion({ workspaceName: "Acme" }, { failures: { "GET /v1/users/me": { status: 429, remaining: 1, retryAfter: "2" } } });
    const client = createNotionClient({ token: "t", fetch: fake.fetch, sleep: clock.sleep, now: clock.now, minIntervalMs: 0 });
    const me = await client.me();
    expect(me.bot?.workspace_name).toBe("Acme");
    expect(fake.calls.filter((c) => c === "GET /v1/users/me")).toHaveLength(2);
    expect(clock.sleeps).toContain(2000);
  });

  it("backs off exponentially when a 503 has no Retry-After, and gives up after 4 retries", async () => {
    const clock = fakeClock();
    const fake = fakeNotion({}, { failures: { "GET /v1/users/me": { status: 503, remaining: Infinity } } });
    const client = createNotionClient({ token: "t", fetch: fake.fetch, sleep: clock.sleep, now: clock.now, minIntervalMs: 0 });
    const err = await client.me().catch((e) => e);
    expect(err).toBeInstanceOf(NotionApiError);
    expect(err).toMatchObject({ status: 503 });
    // 1 attempt + 4 retries
    expect(fake.calls.filter((c) => c === "GET /v1/users/me")).toHaveLength(5);
    expect(clock.sleeps.filter((ms) => ms >= 1000)).toEqual([1000, 2000, 4000, 8000]);
  });

  it("follows start_cursor through every page of search", async () => {
    const search = Array.from({ length: 5 }, (_, i) => ({ object: "page", id: `00000000-0000-0000-0000-00000000000${i}` }));
    const fake = fakeNotion({ search: search as never }, { pageSize: 2 });
    const client = createNotionClient({ token: "t", fetch: fake.fetch, sleep: async () => {}, minIntervalMs: 0 });
    const got: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await client.search(cursor);
      got.push(...page.results.map((r) => r.id));
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    expect(got).toEqual(search.map((s) => s.id));
    expect(fake.calls.filter((c) => c === "POST /v1/search")).toHaveLength(3);
  });

  it("maps a 401 to the unauthorized code, and keeps Notion's code and message for other errors", async () => {
    const fake = fakeNotion({}, { token: "ntn_good" });
    const bad = createNotionClient({ token: "ntn_bad", fetch: fake.fetch, sleep: async () => {}, minIntervalMs: 0 });
    await expect(bad.me()).rejects.toMatchObject({ status: 401, code: "unauthorized", name: "NotionApiError" });

    const missing = createNotionClient({ token: "ntn_good", fetch: fake.fetch, sleep: async () => {}, minIntervalMs: 0 });
    const err = await missing.getPage("00000000-0000-0000-0000-000000000000").catch((e) => e);
    expect(err).toMatchObject({ status: 404, code: "object_not_found", message: "Could not find page." });
  });

  it("uses an http_<status> code for a non-JSON error body", async () => {
    const plain: typeof fetch = async () => new Response("<html>bad gateway</html>", { status: 500 });
    const client = createNotionClient({ token: "t", fetch: plain, sleep: async () => {}, minIntervalMs: 0 });
    await expect(client.me()).rejects.toMatchObject({ status: 500, code: "http_500" });
  });

  it("downloads a file's bytes without the auth header, and refuses one over the cap", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const url = "https://files.example.com/pic.png";
    const seenHeaders: unknown[] = [];
    const fake = fakeNotion({ files: { [url]: bytes } });
    const wrapped: typeof fetch = async (input, init) => {
      seenHeaders.push(init?.headers);
      return fake.fetch(input, init);
    };
    const client = createNotionClient({ token: "t", fetch: wrapped, sleep: async () => {}, minIntervalMs: 0 });
    expect(Array.from(await client.download(url))).toEqual([1, 2, 3, 4, 5]);
    expect(seenHeaders[0]).toBeUndefined();
    await expect(client.download(url, 4)).rejects.toThrow(/larger than 4 bytes/);
  });
  it("retries a dropped connection and a timeout, then gives up after MAX_RETRIES", async () => {
    const fake = fakeNotion({ workspaceName: "Acme" });
    let failuresLeft = 2;
    const flaky: typeof fetch = async (input, init) => {
      if (failuresLeft-- > 0) throw failuresLeft === 1 ? new TypeError("fetch failed") : Object.assign(new Error("timed out"), { name: "TimeoutError" });
      return fake.fetch(input, init);
    };
    const client = createNotionClient({ token: "t", fetch: flaky, sleep: async () => {}, minIntervalMs: 0 });
    expect((await client.me()).bot?.workspace_name).toBe("Acme");

    let calls = 0;
    const down: typeof fetch = async () => {
      calls++;
      throw new TypeError("fetch failed");
    };
    const dead = createNotionClient({ token: "t", fetch: down, sleep: async () => {}, minIntervalMs: 0 });
    await expect(dead.me()).rejects.toThrow("fetch failed");
    expect(calls).toBe(5);
  });

  it("gives every request an abort signal, and retries a download whose connection dropped", async () => {
    const url = "https://files.example.com/doc.pdf";
    const fake = fakeNotion({ workspaceName: "Acme", files: { [url]: new Uint8Array([7, 8]) } });
    const signals: unknown[] = [];
    let dropNext = true;
    const wrapped: typeof fetch = async (input, init) => {
      signals.push(init?.signal);
      if (String(input) === url && dropNext) {
        dropNext = false;
        throw new TypeError("terminated");
      }
      return fake.fetch(input, init);
    };
    const client = createNotionClient({ token: "t", fetch: wrapped, sleep: async () => {}, minIntervalMs: 0 });
    await client.me();
    expect(Array.from(await client.download(url))).toEqual([7, 8]);
    expect(signals).toHaveLength(3);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it("does not retry a 4xx error", async () => {
    let calls = 0;
    const notFound: typeof fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ code: "object_not_found", message: "nope" }), { status: 404 });
    };
    const client = createNotionClient({ token: "t", fetch: notFound, sleep: async () => {}, minIntervalMs: 0 });
    await expect(client.me()).rejects.toMatchObject({ status: 404 });
    expect(calls).toBe(1);
  });
});
