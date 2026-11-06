import { afterEach, describe, expect, it, vi } from "vitest";
import { checkJiraConnection, listJiraBoards } from "../jira/connect";
import { JiraApiError } from "../jira/client";

/** JIRA is never called for real: fetch is replaced for each test. */
const creds = { baseUrl: "https://your-site.atlassian.net", email: "ann@example.com", apiToken: "tok" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubFetch(handler: (url: URL) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: string | URL | Request) => handler(new URL(String(input))));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkJiraConnection", () => {
  it("returns who the token belongs to, and every project across pages, sorted by name", async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url.pathname + url.search);
      if (url.pathname === "/rest/api/3/myself") return json({ accountId: "acc-1", displayName: "Ann Smith", emailAddress: "ann@example.com" });
      if (url.pathname === "/rest/api/3/project/search") {
        if (url.searchParams.get("startAt") === "0") {
          return json({ values: [{ id: "10", key: "ZED", name: "Zeta" }, { id: "11", key: "ALP", name: "Alpha" }], isLast: false });
        }
        return json({ values: [{ id: "12", key: "MID", name: "Mid Project" }], isLast: true });
      }
      return new Response("unexpected", { status: 500 });
    });

    const info = await checkJiraConnection(creds);

    expect(info.myself).toEqual({ accountId: "acc-1", displayName: "Ann Smith", emailAddress: "ann@example.com" });
    expect(info.projects).toEqual([
      { id: "11", key: "ALP", name: "Alpha" },
      { id: "12", key: "MID", name: "Mid Project" },
      { id: "10", key: "ZED", name: "Zeta" },
    ]);
    expect(seen).toContain("/rest/api/3/project/search?startAt=0&maxResults=50");
    expect(seen).toContain("/rest/api/3/project/search?startAt=2&maxResults=50");
  });

  it("maps a 401 or 403 to a readable message about the email and token", async () => {
    stubFetch(() => json({ errorMessages: ["Unauthorized"] }, 401));
    await expect(checkJiraConnection(creds)).rejects.toThrow("JIRA rejected this email and API token.");

    stubFetch(() => json({ errorMessages: ["Forbidden"] }, 403));
    await expect(checkJiraConnection(creds)).rejects.toThrow("JIRA rejected this email and API token.");
  });

  it("maps a 404 on /myself to 'no site at this address'", async () => {
    stubFetch(() => new Response("<html>not found</html>", { status: 404 }));
    await expect(checkJiraConnection(creds)).rejects.toThrow("No JIRA Cloud site at this address.");
  });

  it("names the host when the site can't be reached at all", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(checkJiraConnection(creds)).rejects.toThrow("Couldn't reach your-site.atlassian.net.");
  });

  it("keeps a JiraApiError for any other status", async () => {
    stubFetch(() => json({ errorMessages: ["boom"] }, 500));
    const err = await checkJiraConnection(creds).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraApiError);
    expect((err as JiraApiError).status).toBe(500);
  });
});

describe("listJiraBoards", () => {
  it("lists the project's boards across pages, asking JIRA for that project key", async () => {
    const fetchMock = stubFetch((url) => {
      expect(url.pathname).toBe("/rest/agile/1.0/board");
      expect(url.searchParams.get("projectKeyOrId")).toBe("ALP");
      if (url.searchParams.get("startAt") === "0") return json({ values: [{ id: 3, name: "Alpha board", type: "scrum", location: {} }], isLast: false });
      return json({ values: [{ id: 9, name: "Kanban", type: "kanban" }], isLast: true });
    });

    const boards = await listJiraBoards(creds, "ALP");

    expect(boards).toEqual([
      { id: 3, name: "Alpha board", type: "scrum" },
      { id: 9, name: "Kanban", type: "kanban" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the JiraApiError from a failed board request", async () => {
    stubFetch(() => json({ errorMessages: ["The requested project was not found"] }, 404));
    await expect(listJiraBoards(creds, "NOPE")).rejects.toBeInstanceOf(JiraApiError);
  });
});
