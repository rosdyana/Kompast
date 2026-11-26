import { describe, expect, it } from "vitest";
import { issuePath, parseIssueUrl } from "../issue-link";

const origin = "https://kompast.example.com";

describe("parseIssueUrl", () => {
  it("parses an issue URL from this instance", () => {
    expect(parseIssueUrl(`${origin}/issues/team_1/KMP/42`, origin)).toEqual({ teamId: "team_1", projectKey: "KMP", keySeq: 42 });
  });

  it("ignores the ?from= query, a hash, a trailing slash and surrounding whitespace", () => {
    expect(parseIssueUrl(`  ${origin}/issues/team_1/KMP/42/?from=board#comments \n`, origin)).toEqual({ teamId: "team_1", projectKey: "KMP", keySeq: 42 });
  });

  it("accepts the 'none' team id used for projects with no team", () => {
    expect(parseIssueUrl(`${origin}/issues/none/OPS/7`, origin)).toEqual({ teamId: "none", projectKey: "OPS", keySeq: 7 });
  });

  it("rejects other hosts, other routes, bad sequence numbers and text around the URL", () => {
    expect(parseIssueUrl("https://evil.example.com/issues/t/KMP/1", origin)).toBeNull();
    expect(parseIssueUrl(`${origin}/docs/page_1`, origin)).toBeNull();
    expect(parseIssueUrl(`${origin}/issues/t/KMP/abc`, origin)).toBeNull();
    expect(parseIssueUrl(`${origin}/issues/t/KMP/0`, origin)).toBeNull();
    expect(parseIssueUrl(`see ${origin}/issues/t/KMP/1`, origin)).toBeNull();
    expect(parseIssueUrl("KMP-1", origin)).toBeNull();
    expect(parseIssueUrl("", origin)).toBeNull();
  });
});

describe("issuePath", () => {
  it("builds the route path and falls back to 'none' for a missing team", () => {
    expect(issuePath({ teamId: "team_1", projectKey: "KMP", keySeq: 42 })).toBe("/issues/team_1/KMP/42");
    expect(issuePath({ teamId: null, projectKey: "OPS", keySeq: "7" })).toBe("/issues/none/OPS/7");
  });

  it("round-trips through parseIssueUrl", () => {
    const ref = { teamId: "team_1", projectKey: "KMP", keySeq: 9 };
    expect(parseIssueUrl(origin + issuePath(ref), origin)).toEqual(ref);
  });
});
