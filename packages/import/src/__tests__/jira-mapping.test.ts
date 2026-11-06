import { describe, expect, it } from "vitest";
import type { JiraDiscovery, JiraDiscoveredPerson } from "../jira/discover";
import { suggestJiraMapping, mergeJiraMapping, DEFAULT_ATTACHMENT_MAX_BYTES, type JiraMigrationMapping, type KompastMappingTargets } from "../jira/mapping";

/** A default project's priority levels, in order (packages/core/src/priority.ts). */
const SEEDED_LEVELS = [
  { key: "very_low", name: "Very Low" },
  { key: "low", name: "Low" },
  { key: "medium", name: "Medium" },
  { key: "high", name: "High" },
  { key: "critical", name: "Critical" },
];

/** Only the fields suggestJiraMapping reads are filled in. */
function discoveryWith(parts: { statuses?: JiraDiscovery["statuses"]; issueTypes?: JiraDiscovery["issueTypes"]; people?: JiraDiscoveredPerson[] }): JiraDiscovery {
  return {
    statuses: parts.statuses ?? [],
    issueTypes: parts.issueTypes ?? [],
    people: parts.people ?? [],
  } as unknown as JiraDiscovery;
}

function person(overrides: Partial<JiraDiscoveredPerson> & { accountId: string; displayName: string }): JiraDiscoveredPerson {
  return { emailAddress: null, active: true, accountType: "atlassian", touches: 1, lastSprintNumber: null, ...overrides };
}

const members = [
  { userId: "u-jeff", name: "jeff5 lin", email: "jeff@example.com" },
  { userId: "u-ann", name: "Ann Smith", email: "ann@example.com" },
  { userId: "u-dup-1", name: "Sam Lee", email: null },
  { userId: "u-dup-2", name: "sam_lee", email: null },
];

describe("suggestJiraMapping", () => {
  it("matches people by email first (case-insensitive)", () => {
    const m = suggestJiraMapping(
      discoveryWith({ people: [person({ accountId: "a1", displayName: "Totally Different Name", emailAddress: "JEFF@example.com" })] }),
      { statuses: [], types: [], members, columns: [], priorities: [] },
    );
    expect(m.people[0]).toEqual({ accountId: "a1", displayName: "Totally Different Name", action: "map", kompastUserId: "u-jeff", confidence: "email" });
  });

  it("falls back to a normalized display name match: jeff5_lin matches the member named 'jeff5 lin'", () => {
    const m = suggestJiraMapping(discoveryWith({ people: [person({ accountId: "a2", displayName: "jeff5_lin" })] }), { statuses: [], types: [], members, columns: [], priorities: [] });
    expect(m.people[0]).toEqual({ accountId: "a2", displayName: "jeff5_lin", action: "map", kompastUserId: "u-jeff", confidence: "name" });
  });

  it("a person with no email and no name match is 'former' with confidence none", () => {
    const m = suggestJiraMapping(discoveryWith({ people: [person({ accountId: "a3", displayName: "Nobody Here" })] }), { statuses: [], types: [], members, columns: [], priorities: [] });
    expect(m.people[0]).toEqual({ accountId: "a3", displayName: "Nobody Here", action: "former", confidence: "none" });
  });

  it("an ambiguous display name (two members) is not guessed: 'former'", () => {
    const m = suggestJiraMapping(discoveryWith({ people: [person({ accountId: "a4", displayName: "Sam Lee" })] }), { statuses: [], types: [], members, columns: [], priorities: [] });
    expect(m.people[0]).toMatchObject({ action: "former", confidence: "none" });
  });

  it("statuses and types match a Kompast row by case-insensitive name, else are created", () => {
    const m = suggestJiraMapping(
      discoveryWith({
        statuses: [
          { name: "to do", categoryKey: "new" },
          { name: "Code Review", categoryKey: "indeterminate" },
        ],
        issueTypes: [
          { name: "TASK", subtask: false },
          { name: "Improvement", subtask: false },
        ],
      }),
      {
        statuses: [{ id: "st-todo", name: "To Do", category: "todo" }],
        types: [{ id: "ty-task", name: "Task" }],
        members: [],
        columns: [],
        priorities: [],
      },
    );

    expect(m.statuses[0]).toEqual({ jiraName: "to do", category: "todo", action: "map", kompastStatusId: "st-todo" });
    expect(m.statuses[1]).toEqual({ jiraName: "Code Review", category: "in_progress", action: "create", column: { mode: "new", afterColumnId: null } });
    expect(m.types[0]).toEqual({ jiraName: "TASK", action: "map", kompastTypeId: "ty-task" });
    expect(m.types[1]).toEqual({ jiraName: "Improvement", action: "create" });
  });

  it("defaults the attachment limit to 10 MiB", () => {
    const m = suggestJiraMapping(discoveryWith({}), { statuses: [], types: [], members: [], columns: [], priorities: [] });
    expect(m.attachmentMaxBytes).toBe(10 * 1024 * 1024);
    expect(DEFAULT_ATTACHMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});

/** A board like createProject's default: one column per status, in workflow order. */
const defaultBoard: KompastMappingTargets = {
  priorities: SEEDED_LEVELS,
  statuses: [
    { id: "s-backlog", name: "Backlog", category: "todo" },
    { id: "s-todo", name: "To Do", category: "todo" },
    { id: "s-prog", name: "In Progress", category: "in_progress" },
    { id: "s-review", name: "In Review", category: "in_progress" },
    { id: "s-done", name: "Done", category: "done" },
  ],
  types: [],
  members: [],
  columns: [
    { id: "c-backlog", name: "Backlog", order: 0, statusIds: ["s-backlog"] },
    { id: "c-todo", name: "To Do", order: 1, statusIds: ["s-todo"] },
    { id: "c-prog", name: "In Progress", order: 2, statusIds: ["s-prog"] },
    { id: "c-review", name: "In Review", order: 3, statusIds: ["s-review"] },
    { id: "c-done", name: "Done", order: 4, statusIds: ["s-done"] },
  ],
};

describe("suggestJiraMapping column placement", () => {
  it("places a created status by its category: to-do after the last to-do column, in-progress before the first done column, done at the end", () => {
    const m = suggestJiraMapping(
      discoveryWith({
        statuses: [
          { name: "Triage", categoryKey: "new" },
          { name: "Code Review", categoryKey: "indeterminate" },
          { name: "Released", categoryKey: "done" },
        ],
      }),
      defaultBoard,
    );
    expect(m.statuses.map((s) => s.column)).toEqual([
      { mode: "new", afterColumnId: "c-todo" },
      { mode: "new", afterColumnId: "c-review" },
      { mode: "new", afterColumnId: "c-done" },
    ]);
  });

  it("a board with no to-do column puts a new to-do status first", () => {
    const m = suggestJiraMapping(discoveryWith({ statuses: [{ name: "Triage", categoryKey: "new" }] }), {
      ...defaultBoard,
      statuses: defaultBoard.statuses.filter((s) => s.category !== "todo"),
      columns: defaultBoard.columns.filter((c) => c.statusIds[0] !== "s-backlog" && c.statusIds[0] !== "s-todo"),
    });
    expect(m.statuses[0]!.column).toEqual({ mode: "new", afterColumnId: null });
  });
});

describe("mergeJiraMapping", () => {
  const targets: KompastMappingTargets = {
    ...defaultBoard,
    types: [{ id: "ty-task", name: "Task" }],
    members: [{ userId: "u-ann", name: "Ann", email: null }],
  };

  const previous: JiraMigrationMapping = {
    statuses: [
      { jiraName: "To Do", category: "todo", action: "map", kompastStatusId: "s-todo" },
      { jiraName: "Blocked", category: "in_progress", action: "create", column: { mode: "join", columnId: "c-prog" } },
      { jiraName: "Gone Status", category: "done", action: "create" },
      { jiraName: "Stale", category: "todo", action: "map", kompastStatusId: "s-deleted" },
    ],
    types: [{ jiraName: "task", action: "map", kompastTypeId: "ty-task" }],
    people: [
      { accountId: "acc-ann", displayName: "Ann", action: "map", kompastUserId: "u-ann", confidence: "name" },
      { accountId: "acc-old", displayName: "Old", action: "former", confidence: "none" },
    ],
    attachmentMaxBytes: null,
    priorities: [
      { jiraName: "Highest", kompastKey: "high" },
      { jiraName: "Lowest", kompastKey: "gone" },
    ],
  };

  const suggested: JiraMigrationMapping = {
    statuses: [
      { jiraName: "To Do", category: "todo", action: "map", kompastStatusId: "s-todo" },
      { jiraName: "Blocked", category: "in_progress", action: "create", column: { mode: "new", afterColumnId: "c-review" } },
      { jiraName: "Stale", category: "todo", action: "create", column: { mode: "new", afterColumnId: "c-todo" } },
      { jiraName: "New Status", category: "done", action: "create", column: { mode: "new", afterColumnId: "c-done" } },
    ],
    types: [{ jiraName: "Task", action: "map", kompastTypeId: "ty-task" }],
    people: [
      { accountId: "acc-ann", displayName: "Ann", action: "map", kompastUserId: "u-ann", confidence: "email" },
      { accountId: "acc-new", displayName: "New Person", action: "former", confidence: "none" },
    ],
    attachmentMaxBytes: 1024,
    priorities: [
      { jiraName: "Highest", kompastKey: "critical" },
      { jiraName: "Lowest", kompastKey: "very_low" },
    ],
  };

  it("keeps the user's entries that still point at existing rows, takes the suggestion for new or broken ones, and drops what JIRA no longer has", () => {
    const merged = mergeJiraMapping(previous, suggested, targets);

    expect(merged.statuses).toEqual([
      // Kept: same JIRA name, its status still exists.
      { jiraName: "To Do", category: "todo", action: "map", kompastStatusId: "s-todo" },
      // Kept: a created status whose join column still exists.
      { jiraName: "Blocked", category: "in_progress", action: "create", column: { mode: "join", columnId: "c-prog" } },
      // Taken from the suggestion: the previous "Stale" pointed at a status that no longer exists.
      { jiraName: "Stale", category: "todo", action: "create", column: { mode: "new", afterColumnId: "c-todo" } },
      // New in JIRA: the suggestion. "Gone Status" is no longer in JIRA, so it's dropped.
      { jiraName: "New Status", category: "done", action: "create", column: { mode: "new", afterColumnId: "c-done" } },
    ]);
    // Matched case-insensitively, so the user's entry (with its spelling) is the one kept.
    expect(merged.types).toEqual([{ jiraName: "task", action: "map", kompastTypeId: "ty-task" }]);
    expect(merged.people).toEqual([
      { accountId: "acc-ann", displayName: "Ann", action: "map", kompastUserId: "u-ann", confidence: "name" },
      { accountId: "acc-new", displayName: "New Person", action: "former", confidence: "none" },
    ]);
    // The attachment limit is the user's choice, so it survives the re-scan.
    expect(merged.attachmentMaxBytes).toBeNull();
    // "Highest" keeps the user's level; "Lowest" pointed at a level the project no longer has, so it takes the suggestion.
    expect(merged.priorities).toEqual([
      { jiraName: "Highest", kompastKey: "high" },
      { jiraName: "Lowest", kompastKey: "very_low" },
    ]);
  });

  it("takes the suggestion for a kept-by-name person whose Kompast account is gone", () => {
    const merged = mergeJiraMapping(
      previous,
      suggested,
      { ...targets, members: [] },
    );
    expect(merged.people[0]).toEqual({ accountId: "acc-ann", displayName: "Ann", action: "map", kompastUserId: "u-ann", confidence: "email" });
  });
});

describe("JIRA priority suggestion and merge (per project's levels)", () => {
  const discoveryWithPriorities = (names: string[]) => ({ ...discoveryWith({}), priorities: names.map((name) => ({ name })) }) as unknown as JiraDiscovery;
  const targetsWith = (priorities: KompastMappingTargets["priorities"]): KompastMappingTargets => ({ statuses: [], types: [], members: [], columns: [], priorities });

  it("suggests a level for each JIRA priority from the synonym table, falling back to medium", () => {
    const m = suggestJiraMapping(
      discoveryWithPriorities(["Highest", "Blocker", "Major", "Normal", "Minor", "Lowest", "Trivial", "Weird"]),
      targetsWith(SEEDED_LEVELS),
    );
    expect(m.priorities).toEqual([
      { jiraName: "Highest", kompastKey: "critical" },
      { jiraName: "Blocker", kompastKey: "critical" },
      { jiraName: "Major", kompastKey: "high" },
      { jiraName: "Normal", kompastKey: "medium" },
      { jiraName: "Minor", kompastKey: "low" },
      { jiraName: "Lowest", kompastKey: "very_low" },
      { jiraName: "Trivial", kompastKey: "very_low" },
      { jiraName: "Weird", kompastKey: "medium" },
    ]);
  });

  it("a discovery with no priorities list suggests no priority entries", () => {
    expect(suggestJiraMapping(discoveryWith({}), targetsWith(SEEDED_LEVELS)).priorities).toEqual([]);
  });

  it("merge keeps a previous priority choice only while its level exists, and reads a mapping saved without priorities as no choices", () => {
    const suggested = suggestJiraMapping(discoveryWithPriorities(["Highest", "Lowest"]), targetsWith(SEEDED_LEVELS));
    const previous = { statuses: [], types: [], people: [], attachmentMaxBytes: null, priorities: [{ jiraName: "Lowest", kompastKey: "low" }] } as JiraMigrationMapping;
    const merged = mergeJiraMapping(previous, suggested, targetsWith(SEEDED_LEVELS));
    expect(merged.priorities).toEqual([
      { jiraName: "Highest", kompastKey: "critical" },
      { jiraName: "Lowest", kompastKey: "low" },
    ]);

    const legacy = { statuses: [], types: [], people: [], attachmentMaxBytes: null } as unknown as JiraMigrationMapping;
    expect(mergeJiraMapping(legacy, suggested, targetsWith(SEEDED_LEVELS)).priorities).toEqual(suggested.priorities);
  });
});
