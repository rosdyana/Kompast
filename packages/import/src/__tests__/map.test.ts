import { describe, expect, it } from "vitest";
import { collectJiraEmails, mapJiraPriority, mapJiraStatusCategory } from "../jira/map";
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
  it("maps known JIRA priority names case-insensitively", () => {
    expect(mapJiraPriority("Highest")).toBe("highest");
    expect(mapJiraPriority("low")).toBe("low");
  });

  it("falls back to medium for null/unknown", () => {
    expect(mapJiraPriority(null)).toBe("medium");
    expect(mapJiraPriority(undefined)).toBe("medium");
    expect(mapJiraPriority("Blocker")).toBe("medium");
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
