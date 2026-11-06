import { describe, expect, it, vi } from "vitest";
import type { JiraMigrationMapping, JiraFieldMapping } from "@kompast/core";
import { createJiraClient } from "../jira/client";
import { discoverJiraProject, type JiraDiscovery, type JiraDiscoveredField } from "../jira/discover";
import { classifyJiraField, convertJiraValue, sampleText, optionValuesOf } from "../jira/fields";
import { mergeJiraMapping, suggestJiraMapping, type KompastMappingTargets } from "../jira/mapping";

/**
 * The field rules, against the ZTRD project's real field list (the fieldUsage
 * and schemas in the Phase 3b spec). Nothing here touches JIRA or the database.
 */

const JSW_STORY = "com.pyxis.greenhopper.jira:jsw-story-points";
const DATEPICKER = "com.atlassian.jira.plugin.system.customfieldtypes:datepicker";
const SELECT = "com.atlassian.jira.plugin.system.customfieldtypes:select";
const MULTI = "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes";

function field(id: string, name: string, schemaType: string | null, opts: Partial<JiraDiscoveredField> = {}): JiraDiscoveredField {
  return {
    id,
    name,
    custom: id.startsWith("customfield_"),
    schemaType,
    schemaItems: null,
    schemaCustom: null,
    ...opts,
  };
}

/** The ZTRD discovery's fields, usage and option values (the spec's table). */
function ztrdDiscovery(overrides: { fieldOptions?: JiraDiscovery["fieldOptions"]; fields?: JiraDiscoveredField[]; fieldUsage?: Record<string, number> } = {}): JiraDiscovery {
  const fields: JiraDiscoveredField[] = overrides.fields ?? [
    field("summary", "Summary", "string", { custom: false }),
    field("customfield_10016", "Story point estimate", "number", { schemaCustom: JSW_STORY }),
    field("customfield_10015", "Start date", "date", { schemaCustom: DATEPICKER }),
    field("customfield_10053", "DueDate Set", "option", { schemaCustom: SELECT }),
    field("customfield_10036", "Topic", "option", { schemaCustom: SELECT }),
    field("timeestimate", "Remaining Estimate", "number", { custom: false }),
    field("customfield_10021", "Flagged", "array", { schemaItems: "option", schemaCustom: MULTI }),
    field("customfield_10017", "Issue color", "string", { schemaCustom: "com.pyxis.greenhopper.jira:jsw-issue-color" }),
    field("customfield_10080", "Checklist Progress %", "number", { schemaCustom: "com.atlassian.forge:checklist-progress" }),
    field("customfield_10000", "Development", "any", { schemaCustom: "com.atlassian.jira.plugins:devsummarycf" }),
    field("customfield_10019", "Rank", "any", { schemaCustom: "com.pyxis.greenhopper.jira:gh-lexo-rank" }),
    field("customfield_10248", "Agent Sessions", "array", { schemaItems: "json", schemaCustom: "com.atlassian.teamwork:agent-sessions" }),
    field("customfield_10020", "Sprint", "array", { schemaItems: "json", schemaCustom: "com.pyxis.greenhopper.jira:gh-sprint" }),
  ];
  const fieldUsage = overrides.fieldUsage ?? {
    summary: 3415,
    customfield_10016: 1559,
    customfield_10015: 892,
    customfield_10053: 1061,
    customfield_10036: 539,
    timeestimate: 637,
    customfield_10021: 2,
    customfield_10017: 30,
    customfield_10080: 18,
    customfield_10000: 3410,
    customfield_10019: 3415,
    customfield_10248: 2,
    customfield_10020: 3000,
  };
  return {
    fields,
    fieldUsage,
    fieldOptions: overrides.fieldOptions ?? {
      customfield_10053: [{ value: "Yes", count: 900 }, { value: "No", count: 161 }],
      customfield_10036: [{ value: "Alpha", count: 300 }, { value: "Beta", count: 239 }],
      customfield_10021: [{ value: "Impediment", count: 1 }, { value: "Blocked by vendor", count: 1 }],
    },
    fieldSamples: { customfield_10016: ["2", "0.5", "5"] },
    statuses: [],
    issueTypes: [],
    priorities: [],
    people: [],
  } as unknown as JiraDiscovery;
}

const kompast: KompastMappingTargets = { statuses: [], types: [], members: [], columns: [], priorities: [], properties: [] };

function fieldsById(mapping: JiraMigrationMapping): Map<string, JiraFieldMapping> {
  return new Map((mapping.fields ?? []).map((f) => [f.jiraFieldId, f]));
}

describe("suggestJiraMapping: fields (the ZTRD field list)", () => {
  it("routes each used field to its core target, a new property, a skip, or leaves it out (handled or not migratable)", () => {
    const fields = fieldsById(suggestJiraMapping(ztrdDiscovery(), kompast));

    expect(fields.get("customfield_10016")).toEqual({ jiraFieldId: "customfield_10016", jiraName: "Story point estimate", action: "core", coreField: "storyPoints" });
    expect(fields.get("customfield_10015")).toEqual({ jiraFieldId: "customfield_10015", jiraName: "Start date", action: "core", coreField: "startDate" });
    expect(fields.get("customfield_10053")).toEqual({
      jiraFieldId: "customfield_10053",
      jiraName: "DueDate Set",
      action: "property",
      create: { name: "DueDate Set", type: "select" },
    });
    expect(fields.get("customfield_10036")).toEqual({ jiraFieldId: "customfield_10036", jiraName: "Topic", action: "property", create: { name: "Topic", type: "select" } });
    expect(fields.get("timeestimate")).toEqual({
      jiraFieldId: "timeestimate",
      jiraName: "Remaining Estimate",
      action: "property",
      create: { name: "Remaining estimate (h)", type: "number" },
      transform: "secondsToHours",
    });
    expect(fields.get("customfield_10021")).toEqual({ jiraFieldId: "customfield_10021", jiraName: "Flagged", action: "property", create: { name: "Flagged", type: "multiSelect" } });
    expect(fields.get("customfield_10017")).toEqual({ jiraFieldId: "customfield_10017", jiraName: "Issue color", action: "skip" });
    expect(fields.get("customfield_10080")).toEqual({ jiraFieldId: "customfield_10080", jiraName: "Checklist Progress %", action: "skip" });

    // Not choices at all: Development and Agent Sessions can't migrate, Rank is board order, Sprint and summary are handled.
    for (const id of ["customfield_10000", "customfield_10019", "customfield_10248", "customfield_10020", "summary"]) {
      expect(fields.has(id)).toBe(false);
    }
  });

  it("a field with only the 'Impediment' option becomes a checkbox", () => {
    const d = ztrdDiscovery({ fieldOptions: { customfield_10021: [{ value: "Impediment", count: 2 }] } });
    expect(fieldsById(suggestJiraMapping(d, kompast)).get("customfield_10021")).toMatchObject({ create: { name: "Flagged", type: "checkbox" } });
  });

  it("when two fields claim story points, the more used keeps the core target and the other becomes a number property", () => {
    const d = ztrdDiscovery({
      fields: [
        ...ztrdDiscovery().fields,
        field("customfield_10999", "Story points (old)", "number", { schemaCustom: JSW_STORY }),
      ],
      fieldUsage: { ...ztrdDiscovery().fieldUsage, customfield_10999: 10 },
    });
    const fields = fieldsById(suggestJiraMapping(d, kompast));
    expect(fields.get("customfield_10016")).toMatchObject({ action: "core", coreField: "storyPoints" });
    expect(fields.get("customfield_10999")).toEqual({
      jiraFieldId: "customfield_10999",
      jiraName: "Story points (old)",
      action: "property",
      create: { name: "Story points (old)", type: "number" },
    });
  });

  it("reuses a project property with the same name (case-insensitive) and a compatible type, and not one with another type", () => {
    const withTopic = suggestJiraMapping(ztrdDiscovery(), {
      ...kompast,
      properties: [{ key: "topic", name: "topic", type: "select", isCore: false }],
    });
    expect(fieldsById(withTopic).get("customfield_10036")).toEqual({ jiraFieldId: "customfield_10036", jiraName: "Topic", action: "property", propertyKey: "topic" });

    const textTopic = suggestJiraMapping(ztrdDiscovery(), {
      ...kompast,
      properties: [{ key: "topic", name: "Topic", type: "number", isCore: false }],
    });
    expect(fieldsById(textTopic).get("customfield_10036")).toMatchObject({ create: { name: "Topic", type: "select" } });
  });

  it("a discovery with no field list (an older one) suggests no fields", () => {
    const m = suggestJiraMapping({ statuses: [], issueTypes: [], people: [] } as unknown as JiraDiscovery, kompast);
    expect(m.fields).toEqual([]);
  });
});

describe("classifyJiraField", () => {
  it("a field JIRA sends with a schema this converter doesn't know is skipped with the unsupported type reason", () => {
    expect(classifyJiraField(field("customfield_9", "Weird", "array", { schemaItems: "issuelinks", custom: true }))).toEqual({
      kind: "skip",
      reason: "unsupported-type",
    });
  });

  it("a user field becomes a person; a list of users takes its first value", () => {
    expect(classifyJiraField(field("customfield_8", "Approver", "user", { custom: true }))).toEqual({ kind: "migrate", create: { name: "Approver", type: "person" } });
    expect(classifyJiraField(field("customfield_8", "Approvers", "array", { schemaItems: "user", custom: true }))).toMatchObject({
      kind: "migrate",
      create: { type: "person" },
      firstValueOnly: true,
    });
  });
});

describe("mergeJiraMapping: fields", () => {
  const targets: KompastMappingTargets = {
    ...kompast,
    properties: [{ key: "topic", name: "Topic", type: "select", isCore: false }],
  };

  it("keeps the user's field choices while their property still exists, and takes the suggestion when it's gone", () => {
    const suggested = suggestJiraMapping(ztrdDiscovery(), targets);
    const previous: JiraMigrationMapping = {
      statuses: [],
      types: [],
      people: [],
      priorities: [],
      attachmentMaxBytes: 10 * 1024 * 1024,
      fields: [
        { jiraFieldId: "customfield_10036", jiraName: "Topic", action: "property", propertyKey: "topic" },
        { jiraFieldId: "customfield_10053", jiraName: "DueDate Set", action: "property", propertyKey: "deleted_one" },
        { jiraFieldId: "customfield_10017", jiraName: "Issue color", action: "property", create: { name: "Colour", type: "text" } },
        { jiraFieldId: "customfield_10080", jiraName: "Checklist Progress %", action: "skip" },
      ],
    };
    const merged = fieldsById(mergeJiraMapping(previous, suggested, targets));

    expect(merged.get("customfield_10036")).toEqual({ jiraFieldId: "customfield_10036", jiraName: "Topic", action: "property", propertyKey: "topic" });
    expect(merged.get("customfield_10053")).toMatchObject({ create: { name: "DueDate Set", type: "select" } });
    expect(merged.get("customfield_10017")).toEqual({ jiraFieldId: "customfield_10017", jiraName: "Issue color", action: "property", create: { name: "Colour", type: "text" } });
    expect(merged.get("customfield_10080")).toEqual({ jiraFieldId: "customfield_10080", jiraName: "Checklist Progress %", action: "skip" });
  });

  it("a previous mapping with no fields list takes the suggestion whole", () => {
    const suggested = suggestJiraMapping(ztrdDiscovery(), targets);
    const previous: JiraMigrationMapping = { statuses: [], types: [], people: [], priorities: [], attachmentMaxBytes: null };
    expect(mergeJiraMapping(previous, suggested, targets).fields).toEqual(suggested.fields);
  });
});

describe("convertJiraValue: the stored format per property type", () => {
  it("numbers: plain, a numeric string, and seconds as hours", () => {
    expect(convertJiraValue(2.5, "number")).toEqual({ kind: "value", value: 2.5 });
    expect(convertJiraValue("3", "number")).toEqual({ kind: "value", value: 3 });
    expect(convertJiraValue(5400, "number", { transform: "secondsToHours" })).toEqual({ kind: "value", value: 1.5 });
    expect(convertJiraValue("lots", "number")).toEqual({ kind: "error", message: "not a number" });
  });

  it("dates: the YYYY-MM-DD part, which is what the date editor stores", () => {
    expect(convertJiraValue("2024-03-01", "date")).toEqual({ kind: "value", value: "2024-03-01" });
    expect(convertJiraValue("2024-03-01T10:00:00.000+0000", "date")).toEqual({ kind: "value", value: "2024-03-01" });
    expect(convertJiraValue("someday", "date")).toEqual({ kind: "error", message: "not a date" });
  });

  it("select: one option's value, a child option as 'parent / child', and a list of two is an error", () => {
    expect(convertJiraValue({ value: "High" }, "select")).toEqual({ kind: "value", value: "High" });
    expect(convertJiraValue({ value: "Parent", child: { value: "Child" } }, "select")).toEqual({ kind: "value", value: "Parent / Child" });
    expect(convertJiraValue([{ value: "A" }, { value: "B" }], "select")).toEqual({ kind: "error", message: "holds several values, but this property takes one" });
  });

  it("multiSelect: each option's value, without repeats; checkbox: true when any value is set", () => {
    expect(convertJiraValue([{ value: "A" }, { value: "B" }, { value: "A" }], "multiSelect")).toEqual({ kind: "value", value: ["A", "B"] });
    expect(convertJiraValue([{ value: "Impediment" }], "checkbox")).toEqual({ kind: "value", value: true });
    expect(convertJiraValue([], "checkbox")).toEqual({ kind: "empty" });
  });

  it("person: the mapped user, or unresolved when the caller can't match them; the first of a list", () => {
    const user = { accountId: "acc-1", displayName: "Ann" };
    expect(convertJiraValue(user, "person", { resolveUser: () => "u-ann" })).toEqual({ kind: "value", value: "u-ann" });
    expect(convertJiraValue(user, "person", { resolveUser: () => null })).toEqual({ kind: "unresolved" });
    expect(convertJiraValue([user, { accountId: "acc-2", displayName: "Bo" }], "person", { resolveUser: (u) => (u.accountId === "acc-1" ? "u-ann" : null) })).toEqual({
      kind: "value",
      value: "u-ann",
    });
  });

  it("textarea: an ADF body becomes its plain text; empty values are empty", () => {
    const adf = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Hello there" }] }] };
    expect(convertJiraValue(adf, "textarea")).toEqual({ kind: "value", value: "Hello there" });
    expect(convertJiraValue(null, "text")).toEqual({ kind: "empty" });
    expect(convertJiraValue("   ", "text")).toEqual({ kind: "empty" });
  });
});

describe("sample and option text", () => {
  it("cuts a long sample to 80 characters, with an ellipsis", () => {
    const text = sampleText("x".repeat(200))!;
    expect(text).toHaveLength(80);
    expect(text.endsWith("…")).toBe(true);
  });

  it("option values: a child option is 'parent / child', and a list keeps each distinct value once", () => {
    expect(optionValuesOf([{ value: "A" }, { value: "A" }, { value: "P", child: { value: "C" } }])).toEqual(["A", "P / C"]);
  });
});

describe("discoverJiraProject: option values and samples", () => {
  /** A one-issue-page JIRA for the project DEMO, answering only what the field scan reads. */
  function fakeJira(fields: unknown[], issues: unknown[]) {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    return vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      switch (url.pathname) {
        case "/rest/api/3/myself":
          return json({ accountId: "me", displayName: "Me" });
        case "/rest/api/3/project/DEMO":
          return json({ id: "1", key: "DEMO", name: "Demo" });
        case "/rest/agile/1.0/board":
          return json({ values: [], isLast: true });
        case "/rest/api/3/project/DEMO/statuses":
          return json([]);
        case "/rest/api/3/priority":
          return json([]);
        case "/rest/api/3/field":
          return json(fields);
        case "/rest/api/3/search/jql":
          return json({ issues, isLast: true });
        default:
          return new Response(`no route for ${url.pathname}`, { status: 404 });
      }
    });
  }
  const creds = { baseUrl: "https://demo.atlassian.net", email: "me@example.com", apiToken: "tok" };
  const fieldList = [
    { id: "customfield_10036", name: "Topic", custom: true, schema: { type: "option", custom: SELECT } },
    { id: "customfield_10021", name: "Flagged", custom: true, schema: { type: "array", items: "option", custom: MULTI } },
    { id: "customfield_10016", name: "Story point estimate", custom: true, schema: { type: "number", custom: JSW_STORY } },
  ];

  it("counts each option per issue (once per issue) and keeps the first samples of each used field", async () => {
    const issues = [
      { id: "1", key: "DEMO-1", fields: { summary: "one", created: "2024-01-01", customfield_10036: { value: "Alpha" }, customfield_10021: [{ value: "Impediment" }], customfield_10016: 2.5 } },
      { id: "2", key: "DEMO-2", fields: { summary: "two", created: "2024-01-02", customfield_10036: { value: "Alpha" }, customfield_10021: [{ value: "Impediment" }, { value: "Vendor" }], customfield_10016: null } },
      { id: "3", key: "DEMO-3", fields: { summary: "three", created: "2024-01-03", customfield_10036: { value: "Beta", child: { value: "Gamma" } }, customfield_10021: [], customfield_10016: 5 } },
    ];
    const fetchMock = fakeJira(fieldList, issues);
    const client = createJiraClient(creds, { fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} });

    const d = await discoverJiraProject(client, { projectKey: "DEMO" });

    expect(d.fieldOptions?.customfield_10036).toEqual([
      { value: "Alpha", count: 2 },
      { value: "Beta / Gamma", count: 1 },
    ]);
    expect(d.fieldOptions?.customfield_10021).toEqual([
      { value: "Impediment", count: 2 },
      { value: "Vendor", count: 1 },
    ]);
    // A number field isn't option-like: it has samples, not options.
    expect(d.fieldOptions?.customfield_10016).toBeUndefined();
    expect(d.fieldSamples?.customfield_10016).toEqual(["2.5", "5"]);
    expect(d.fieldSamples?.customfield_10036).toEqual(["Alpha", "Beta / Gamma"]);
    expect(d.fieldUsage.customfield_10021).toBe(2);
  });

  it("keeps at most 300 distinct option values per field", async () => {
    const many = Array.from({ length: 305 }, (_, i) => ({ value: `opt-${i}` }));
    const fetchMock = fakeJira(fieldList, [{ id: "1", key: "DEMO-1", fields: { summary: "x", created: "2024-01-01", customfield_10021: many } }]);
    const client = createJiraClient(creds, { fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} });

    const d = await discoverJiraProject(client, { projectKey: "DEMO" });
    expect(d.fieldOptions?.customfield_10021).toHaveLength(300);
  });
});
