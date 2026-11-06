import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJiraIssues } from "../jira/extract";

const creds = { baseUrl: "https://demo.atlassian.net", email: "a@example.com", apiToken: "tok" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const issue = (key: string) => ({ id: key, key, fields: {} });

describe("fetchJiraIssues", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses /rest/api/3/search/jql and follows nextPageToken until isLast", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ issues: [issue("A-1"), issue("A-2")], nextPageToken: "tok-2", isLast: false }))
      .mockResolvedValueOnce(json({ issues: [issue("A-3")], isLast: true }));
    vi.stubGlobal("fetch", fetchMock);

    const issues = await fetchJiraIssues(creds, "project = A");

    expect(issues.map((i) => i.key)).toEqual(["A-1", "A-2", "A-3"]);
    const [first, second] = fetchMock.mock.calls.map((c) => c[0] as URL);
    expect(first!.pathname).toBe("/rest/api/3/search/jql");
    expect(first!.searchParams.get("jql")).toBe("project = A");
    expect(first!.searchParams.get("expand")).toBe("changelog");
    expect(first!.searchParams.has("nextPageToken")).toBe(false);
    expect(first!.searchParams.has("startAt")).toBe(false);
    expect(second!.searchParams.get("nextPageToken")).toBe("tok-2");
  });

  it("stops when no nextPageToken comes back, even without isLast", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ issues: [issue("A-1")] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchJiraIssues(creds, "project = A")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces JIRA's error body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ errorMessages: ["bad jql"] }, 400)));
    await expect(fetchJiraIssues(creds, "nope")).rejects.toThrow(/JIRA API error \(400\).*bad jql/);
  });
});
