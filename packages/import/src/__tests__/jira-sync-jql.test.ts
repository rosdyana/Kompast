import { describe, expect, it } from "vitest";
import { changedSinceJql, jqlTimestampIn, projectKeysJql, resolveTimeZone } from "../jira/sync";

/** The catch-up sync's JQL dates: read in the JIRA account's own time zone, not UTC. */
describe("catch-up sync JQL", () => {
  const instant = new Date("2026-11-06T02:30:00Z");

  it("formats the timestamp in the account's time zone", () => {
    expect(jqlTimestampIn(instant, "Asia/Taipei")).toBe("2026/11/06 10:30");
    expect(jqlTimestampIn(instant, "UTC")).toBe("2026/11/06 02:30");
    expect(jqlTimestampIn(instant, "America/Los_Angeles")).toBe("2026/11/05 18:30");
  });

  it("writes the changed-issues query with that timestamp, oldest change first", () => {
    expect(changedSinceJql("ZTRD", instant, "Asia/Taipei")).toBe('project = "ZTRD" AND updated >= "2026/11/06 10:30" ORDER BY updated ASC, key ASC');
    expect(changedSinceJql("ZTRD", instant, "UTC")).toBe('project = "ZTRD" AND updated >= "2026/11/06 02:30" ORDER BY updated ASC, key ASC');
  });

  it("falls back to UTC for a missing or unknown zone", () => {
    expect(resolveTimeZone(undefined)).toBe("UTC");
    expect(resolveTimeZone(null)).toBe("UTC");
    expect(resolveTimeZone("Not/AZone")).toBe("UTC");
    expect(resolveTimeZone("Asia/Taipei")).toBe("Asia/Taipei");
  });

  it("reads every key of the project in key order", () => {
    expect(projectKeysJql("ZTRD")).toBe('project = "ZTRD" ORDER BY key ASC');
  });
});
