import { describe, expect, it, vi } from "vitest";
import { createJiraClient, JiraApiError } from "../jira/client";

const creds = { baseUrl: "https://demo.atlassian.net", email: "a@example.com", apiToken: "tok" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("createJiraClient", () => {
  it("retries a 429 after the Retry-After delay, then succeeds", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ errorMessages: ["slow down"] }, 429, { "retry-after": "7" }))
      .mockResolvedValueOnce(json({ ok: true }));
    const client = createJiraClient(creds, { fetch: fetchMock, sleep });

    await expect(client.get<{ ok: boolean }>("/rest/api/3/myself")).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it("backs off exponentially on 503 (1s, then 2s) and then succeeds", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(json({ ok: true }));
    const client = createJiraClient(creds, { fetch: fetchMock, sleep });

    await client.get("/rest/api/3/myself");

    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxAttempts and throws the last JIRA error", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchMock = vi.fn().mockImplementation(async () => new Response("still down", { status: 503 }));
    const client = createJiraClient(creds, { fetch: fetchMock, sleep, maxAttempts: 3 });

    const err = await client.get("/rest/api/3/myself").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(JiraApiError);
    expect((err as JiraApiError).status).toBe(503);
    expect((err as Error).message).toBe("JIRA API error (503): still down");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it("does not retry a 400 and throws with JIRA's body", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchMock = vi.fn().mockResolvedValue(json({ errorMessages: ["bad jql"] }, 400));
    const client = createJiraClient(creds, { fetch: fetchMock, sleep });

    await expect(client.get("/rest/api/3/search/jql", { jql: "nope" })).rejects.toThrow(/JIRA API error \(400\).*bad jql/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a network error (fetch throws) with backoff", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(json({ ok: true }));
    const client = createJiraClient(creds, { fetch: fetchMock, sleep });

    await expect(client.get<{ ok: boolean }>("/rest/api/3/myself")).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("never has more requests in flight than maxConcurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return json({ ok: true });
    });
    const client = createJiraClient(creds, { fetch: fetchMock, sleep: async () => {}, maxConcurrency: 2 });

    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => client.get<{ ok: boolean }>(`/rest/api/3/issue/${i}`)));

    expect(results).toHaveLength(6);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(peak).toBe(2);
  });

  it("sends Basic auth built from email:apiToken", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true }));
    const client = createJiraClient(creds, { fetch: fetchMock, sleep: async () => {} });

    await client.get("/rest/api/3/myself");

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("a@example.com:tok").toString("base64")}`);
    expect(headers.accept).toBe("application/json");
  });
});
