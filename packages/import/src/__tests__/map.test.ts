import { describe, expect, it } from "vitest";
import { collectJiraEmails, extractJiraSprints, mapJiraPriority, mapJiraStatusCategory, parseJiraSprintNumber, resolvePriorityKey, suggestPriorityKey } from "../jira/map";
import type { JiraIssue } from "../jira/types";

function issue(overrides: Partial<JiraIssue["fields"]>): JiraIssue {
  return {
    id: "1",
    key: "X-1",
    fields: {
      summary: "s",
      issuetype: { name: "Task", subtask: false },
      status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
      assignee: null,
      reporter: null,
      priority: null,
      labels: [],
      description: null,
      created: "2020-01-01T00:00:00.000+0000",
      ...overrides,
    },
  };
}

describe("mapJiraPriority", () => {
  it("maps JIRA priority names onto the seeded level keys, case-insensitively", () => {
    expect(mapJiraPriority("Highest")).toBe("critical");
    expect(mapJiraPriority("low")).toBe("low");
    expect(mapJiraPriority("Lowest")).toBe("very_low");
  });

  it("falls back to medium for null/unknown", () => {
    expect(mapJiraPriority(null)).toBe("medium");
    expect(mapJiraPriority(undefined)).toBe("medium");
    expect(mapJiraPriority("Something Else")).toBe("medium");
  });
});

describe("suggestPriorityKey and resolvePriorityKey", () => {
  const seeded = [
    { key: "very_low", name: "Very Low" },
    { key: "low", name: "Low" },
    { key: "medium", name: "Medium" },
    { key: "high", name: "High" },
    { key: "critical", name: "Critical" },
  ];

  it("matches a level by its name or key, case-insensitively, before the synonym table", () => {
    const levels = [{ key: "p_urgent", name: "Urgent" }, ...seeded];
    expect(suggestPriorityKey("urgent", levels)).toBe("p_urgent");
    expect(suggestPriorityKey("HIGH", levels)).toBe("high");
  });

  it("uses the synonym table when the key it names exists", () => {
    expect(suggestPriorityKey("Highest", seeded)).toBe("critical");
    expect(suggestPriorityKey("Blocker", seeded)).toBe("critical");
    expect(suggestPriorityKey("Major", seeded)).toBe("high");
    expect(suggestPriorityKey("Normal", seeded)).toBe("medium");
    expect(suggestPriorityKey("Minor", seeded)).toBe("low");
    expect(suggestPriorityKey("Trivial", seeded)).toBe("very_low");
  });

  it("skips a synonym whose key the project lacks, then takes medium", () => {
    const noCritical = seeded.filter((l) => l.key !== "critical");
    expect(suggestPriorityKey("Highest", noCritical)).toBe("medium");
  });

  it("falls back to the middle level when there is no medium either", () => {
    const abc = [{ key: "a", name: "A" }, { key: "b", name: "B" }, { key: "c", name: "C" }];
    expect(suggestPriorityKey("Weird", abc)).toBe("b");
    expect(suggestPriorityKey(null, abc)).toBe("b");
  });

  it("resolvePriorityKey takes the mapping's choice while that key exists, else the suggestion", () => {
    const mapped = [{ jiraName: "Highest", kompastKey: "high" }, { jiraName: "Gone", kompastKey: "deleted" }];
    expect(resolvePriorityKey("highest", seeded, mapped)).toBe("high");
    expect(resolvePriorityKey("Gone", seeded, mapped)).toBe("medium");
    expect(resolvePriorityKey("Lowest", seeded, mapped)).toBe("very_low");
    expect(resolvePriorityKey(undefined, seeded, [])).toBe("medium");
  });
});

describe("mapJiraStatusCategory", () => {
  it("maps JIRA's real category keys, including the 'indeterminate' = in-progress oddity", () => {
    expect(mapJiraStatusCategory("new")).toBe("todo");
    expect(mapJiraStatusCategory("indeterminate")).toBe("in_progress");
    expect(mapJiraStatusCategory("done")).toBe("done");
  });
});

describe("collectJiraEmails", () => {
  it("dedupes across reporter/assignee/comment-authors/worklog-authors, skipping users with no email", () => {
    const issues: JiraIssue[] = [
      issue({
        reporter: { accountId: "1", emailAddress: "Alice@Example.com", displayName: "Alice" },
        assignee: { accountId: "2", emailAddress: "bob@example.com", displayName: "Bob" },
        comment: { comments: [{ id: "c1", author: { accountId: "1", emailAddress: "alice@example.com", displayName: "Alice" }, body: "hi", created: "2020-01-01T00:00:00.000+0000" }] },
        worklog: { worklogs: [{ id: "w1", author: { accountId: "3", displayName: "No Email User" }, timeSpentSeconds: 60, started: "2020-01-01T00:00:00.000+0000" }] },
      }),
      issue({ assignee: { accountId: "4", emailAddress: "carol@example.com", displayName: "Carol" } }),
    ];

    expect(collectJiraEmails(issues)).toEqual(expect.arrayContaining(["alice@example.com", "bob@example.com", "carol@example.com"]));
    expect(collectJiraEmails(issues)).toHaveLength(3);
  });

  it("returns an empty array for issues with no attributed users", () => {
    expect(collectJiraEmails([issue({})])).toEqual([]);
  });
});

describe("sprint field", () => {
  it("finds sprints in whatever custom field holds them, and ignores look-alike arrays", () => {
    const i = issue({
      customfield_10020: [
        { id: 5, name: "Sprint 5", state: "closed", boardId: 1 },
        { id: 6, name: "Sprint 6", state: "ACTIVE", boardId: 1 },
      ],
      customfield_99999: [{ id: 1, name: "not a sprint" }],
    } as Partial<JiraIssue["fields"]>);
    expect(extractJiraSprints(i).map((s) => [s.id, s.state])).toEqual([
      [5, "closed"],
      [6, "active"],
    ]);
    expect(extractJiraSprints(issue({}))).toEqual([]);
  });

  it("reads the sprint number from the name", () => {
    expect(parseJiraSprintNumber("Sprint 42")).toBe(42);
    expect(parseJiraSprintNumber("PROJ Sprint 7")).toBe(7);
    expect(parseJiraSprintNumber("Team A - 2026 W3")).toBe(3);
    expect(parseJiraSprintNumber("Hardening")).toBeNull();
  });
});
