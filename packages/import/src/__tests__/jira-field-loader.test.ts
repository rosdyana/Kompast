import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, and, adminDb as admin } from "@kompast/db";
import { createImportRun, createProject, withAuthorizedTenant } from "@kompast/core";
import { id } from "@kompast/core/ids";
import type { JiraMigrationMapping, JiraFieldMapping } from "@kompast/core";
import {
  finalizeJiraImport,
  loadJiraIssueBatch,
  prepareJiraImport,
  previewJiraMigrationPlan,
  resolveUserFromMapping,
  type JiraImportInput,
  type JiraLoadContext,
  type PreparedJiraImport,
} from "../jira/load";
import type { JiraDiscovery } from "../jira/discover";
import type { JiraIssue, JiraChangelogHistory } from "../jira/types";

/**
 * The field mapping through the loader, against real Postgres, with JIRA reduced
 * to plain objects. Covers each property type's stored format, options added
 * lazily, the error and unresolved paths, a re-run reusing its properties, the
 * changelog for a mapped property, and the preview.
 */
describe("JIRA field mapping: loader (real Postgres)", () => {
  const orgId = "test-jira-fields-org";
  const userId = "test-jira-fields-user";
  const teamId = "test-jira-fields-team";
  const ctx = { userId, organizationId: orgId };
  const BASE = "https://acme.atlassian.net";
  const STORY_FIELD = "customfield_10016";

  const ANN = { accountId: "acc-ann", displayName: "Ann Lee", emailAddress: `${userId}@example.com`, active: true, accountType: "atlassian" };
  const STRANGER = { accountId: "acc-stranger", displayName: "Stranger", active: true, accountType: "atlassian" };
  const ANN_MAPPED = { accountId: ANN.accountId, displayName: ANN.displayName, action: "map" as const, kompastUserId: userId, confidence: "email" as const };

  const ADF_NOTES = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Hello there" }] }] };

  let projectId: string;
  let boardId: string;

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.externalRef).where(eq(schema.externalRef.organizationId, orgId));
    await admin.delete(schema.importRun).where(eq(schema.importRun.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "JIRA Fields Loader Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "Ann Lee", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Fields Team" });
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });
    const project = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "FLD", name: "Fields", actorUserId: userId }));
    projectId = project.projectId;
    boardId = project.boardId;
  });

  afterAll(cleanup);

  /** The mapping's fields: a core story points and start date, then custom properties of each type, and a timeestimate in hours. */
  const FIELDS: JiraFieldMapping[] = [
    { jiraFieldId: STORY_FIELD, jiraName: "Story point estimate", action: "core", coreField: "storyPoints" },
    { jiraFieldId: "customfield_10015", jiraName: "Start date", action: "core", coreField: "startDate" },
    { jiraFieldId: "customfield_20001", jiraName: "Count", action: "property", create: { name: "Count", type: "number" } },
    { jiraFieldId: "customfield_20002", jiraName: "Topic", action: "property", create: { name: "Topic", type: "select" } },
    { jiraFieldId: "customfield_20003", jiraName: "Flags", action: "property", create: { name: "Flags", type: "multiSelect" } },
    { jiraFieldId: "customfield_20004", jiraName: "Blocked", action: "property", create: { name: "Blocked", type: "checkbox" } },
    { jiraFieldId: "customfield_20005", jiraName: "Owner", action: "property", create: { name: "Owner", type: "person" } },
    { jiraFieldId: "customfield_20006", jiraName: "Notes", action: "property", create: { name: "Notes", type: "textarea" } },
    { jiraFieldId: "customfield_20007", jiraName: "Ship date", action: "property", create: { name: "Ship date", type: "date" } },
    { jiraFieldId: "timeestimate", jiraName: "Remaining Estimate", action: "property", create: { name: "Remaining estimate (h)", type: "number" }, transform: "secondsToHours" },
    { jiraFieldId: "customfield_20008", jiraName: "Skipped", action: "skip" },
  ];

  const mapping = (fields: JiraFieldMapping[] = FIELDS): JiraMigrationMapping => ({
    statuses: [],
    types: [],
    people: [ANN_MAPPED],
    priorities: [],
    attachmentMaxBytes: null,
    fields,
  });

  const fieldOptions: NonNullable<JiraDiscovery["fieldOptions"]> = {
    customfield_20002: [
      { value: "Alpha", count: 3 },
      { value: "Beta", count: 1 },
    ],
    customfield_20003: [
      { value: "A", count: 1 },
      { value: "B", count: 1 },
    ],
  };

  function importInput(m: JiraMigrationMapping): JiraImportInput {
    return { statuses: [{ name: "To Do", categoryKey: "new" }], types: [{ name: "Task" }], sprints: [], mapping: m, fieldOptions };
  }

  /** Prepare, one batch, finalize: one tenant transaction, as a page runs it. */
  async function run(issues: JiraIssue[], m: JiraMigrationMapping = mapping()) {
    const importRunId = (
      await withAuthorizedTenant(ctx, (tx) => createImportRun(tx, { organizationId: orgId, projectId, source: "jira", dryRun: false, config: {}, createdBy: userId }))
    ).importRunId;
    const base: JiraLoadContext = {
      organizationId: orgId,
      projectId,
      boardId,
      importRunId,
      actorUserId: userId,
      dryRun: false,
      jiraBaseUrl: BASE,
      jiraProjectKey: "FLD",
      storyPointsFieldId: STORY_FIELD,
    };
    return withAuthorizedTenant(ctx, async (tx) => {
      const prepared = await prepareJiraImport(tx, base, importInput(m));
      const loadCtx: JiraLoadContext = { ...base, resolveUserId: resolveUserFromMapping(m, prepared.formerUserIdByAccount) };
      const batch = await loadJiraIssueBatch(tx, issues, loadCtx, prepared);
      const fin = await finalizeJiraImport(tx, loadCtx, prepared, { deferredParents: batch.deferredParents, deferredLinks: batch.deferredLinks });
      return { prepared, batch, fin, importRunId };
    });
  }

  async function rowFor(key: string) {
    const ref = await admin
      .select()
      .from(schema.externalRef)
      .where(and(eq(schema.externalRef.organizationId, orgId), eq(schema.externalRef.source, "jira"), eq(schema.externalRef.sourceId, key)));
    const [row] = await admin.select().from(schema.issue).where(eq(schema.issue.id, ref[0]!.entityId));
    return row!;
  }

  function keyOf(prepared: PreparedJiraImport, jiraFieldId: string): string {
    const target = prepared.fieldTargets?.find((t) => t.jiraFieldId === jiraFieldId);
    if (!target?.propertyKey) throw new Error(`no property target for ${jiraFieldId}`);
    return target.propertyKey;
  }

  function jiraIssue(key: string, fields: Record<string, unknown> = {}, extra: Partial<JiraIssue> = {}): JiraIssue {
    return {
      id: key,
      key,
      fields: {
        summary: `${key} summary`,
        issuetype: { name: "Task", subtask: false },
        status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
        assignee: null,
        reporter: ANN,
        priority: { name: "Medium" },
        labels: [],
        description: null,
        created: "2024-01-01T00:00:00.000+0000",
        ...fields,
      } as unknown as JiraIssue["fields"],
      ...extra,
    };
  }

  it("writes each field in the stored format its property type reads, and options a property didn't list yet are appended", async () => {
    const issue = jiraIssue("FLD-1", {
      [STORY_FIELD]: 2.5,
      customfield_10015: "2024-03-01",
      customfield_20001: 4,
      customfield_20002: { value: "Gamma" },
      customfield_20003: [{ value: "A" }, { value: "B" }],
      customfield_20004: [{ value: "Impediment" }],
      customfield_20005: ANN,
      customfield_20006: ADF_NOTES,
      customfield_20007: "2024-05-06",
      timeestimate: 5400,
      customfield_20008: "ignored",
    });
    const { prepared, batch } = await run([issue]);

    expect(batch.errors).toEqual([]);
    expect(batch.counts.fieldValuesWritten).toBe(10);
    expect(batch.counts.fieldValuesSkipped).toBe(0);
    expect(batch.counts.storyPointsRounded).toBe(1);
    expect(batch.counts.propertyOptionsAdded).toBe(1);

    const row = await rowFor("FLD-1");
    expect(row.storyPoints).toBe(3);
    expect(row.startDate?.toISOString()).toBe("2024-03-01T00:00:00.000Z");
    expect(row.customFields).toMatchObject({
      [keyOf(prepared, "customfield_20001")]: 4,
      [keyOf(prepared, "customfield_20002")]: "Gamma",
      [keyOf(prepared, "customfield_20003")]: ["A", "B"],
      [keyOf(prepared, "customfield_20004")]: true,
      [keyOf(prepared, "customfield_20005")]: userId,
      [keyOf(prepared, "customfield_20006")]: "Hello there",
      [keyOf(prepared, "customfield_20007")]: "2024-05-06",
      [keyOf(prepared, "timeestimate")]: 1.5,
    });

    // The option the discovery didn't have was appended to the select's definition.
    const [topic] = await admin.select().from(schema.issuePropertyDefinition).where(and(eq(schema.issuePropertyDefinition.projectId, projectId), eq(schema.issuePropertyDefinition.key, keyOf(prepared, "customfield_20002"))));
    expect((topic!.options as { value: string }[]).map((o) => o.value)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("an unresolved person is skipped and counted; a value that won't convert is skipped, reported as a field error, and the issue is still written", async () => {
    const issues = [
      jiraIssue("FLD-2", { customfield_20001: "lots", customfield_20002: { value: "Alpha" }, customfield_20005: STRANGER, [STORY_FIELD]: null }),
    ];
    const { prepared, batch } = await run(issues);

    expect(batch.counts.issuesCreated).toBe(1);
    expect(batch.errors).toEqual([{ issueKey: "FLD-2", error: "field Count: not a number" }]);
    expect(batch.counts.fieldValuesWritten).toBe(1);
    expect(batch.counts.fieldValuesSkipped).toBe(2);

    const row = await rowFor("FLD-2");
    expect(row.customFields).toMatchObject({ [keyOf(prepared, "customfield_20002")]: "Alpha" });
    expect(row.customFields).not.toHaveProperty(keyOf(prepared, "customfield_20005"));
    expect(row.customFields).not.toHaveProperty(keyOf(prepared, "customfield_20001"));
  });

  it("a re-run reuses the properties it created: nothing is created again, and the targets keep their keys", async () => {
    const importRunId = (
      await withAuthorizedTenant(ctx, (tx) => createImportRun(tx, { organizationId: orgId, projectId, source: "jira", dryRun: false, config: {}, createdBy: userId }))
    ).importRunId;
    const base: JiraLoadContext = { organizationId: orgId, projectId, boardId, importRunId, actorUserId: userId, dryRun: false, jiraBaseUrl: BASE, jiraProjectKey: "FLD" };

    const first = await withAuthorizedTenant(ctx, (tx) => prepareJiraImport(tx, base, importInput(mapping())));
    const second = await withAuthorizedTenant(ctx, (tx) => prepareJiraImport(tx, base, importInput(mapping())));

    expect(first.counts.propertiesCreated).toBe(FIELDS.filter((f) => f.action === "property" && f.create).length);
    expect(second.counts.propertiesCreated).toBe(0);
    expect(second.fieldTargets).toEqual(first.fieldTargets);

    const definitions = await admin.select().from(schema.issuePropertyDefinition).where(eq(schema.issuePropertyDefinition.projectId, projectId));
    const customCount = definitions.filter((d) => !d.isCore).length;
    expect(customCount).toBe(FIELDS.filter((f) => f.action === "property" && f.create).length);
  });

  it("a mapped property's change in the changelog is recorded as customFields.<key>, with the option values", async () => {
    const history = (created: string, items: JiraChangelogHistory["items"]): JiraChangelogHistory => ({ created, author: ANN, items });
    const issue = jiraIssue("FLD-3", {}, {
      changelog: {
        histories: [
          history("2024-02-01T00:00:00.000+0000", [
            { field: "Topic", fieldId: "customfield_20002", from: "1", to: "2", fromString: "Alpha", toString: "Beta" },
            { field: "Story point estimate", fieldId: STORY_FIELD, fromString: null, toString: "5" },
            { field: "Skipped", fieldId: "customfield_20008", fromString: null, toString: "x" },
          ]),
        ],
        total: 1,
      },
    });
    const { prepared, batch } = await run([issue]);
    expect(batch.errors).toEqual([]);

    const row = await rowFor("FLD-3");
    const entries = await admin.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, row.id));
    const topic = entries.find((e) => e.field === `customFields.${keyOf(prepared, "customfield_20002")}`);
    expect(topic).toMatchObject({ fromValue: "Alpha", toValue: "Beta", origin: "import" });
    expect(topic!.createdAt.toISOString()).toBe("2024-02-01T00:00:00.000Z");
    // The mapped story points are written as a storyPoints change; the skipped field leaves no row.
    expect(entries.find((e) => e.field === "storyPoints")).toMatchObject({ toValue: "5" });
    expect(entries.filter((e) => e.field === "Skipped")).toHaveLength(0);
  });

  it("the preview lists each field with its usage, samples and target, and what is handled or can't migrate", async () => {
    await run([jiraIssue("FLD-4", { [STORY_FIELD]: 2 })]);

    const discovery = {
      fields: [
        { id: "summary", name: "Summary", custom: false, schemaType: "string", schemaItems: null, schemaCustom: null },
        { id: "customfield_20002", name: "Topic", custom: true, schemaType: "option", schemaItems: null, schemaCustom: null },
        { id: "customfield_10000", name: "Development", custom: true, schemaType: "any", schemaItems: null, schemaCustom: "com.atlassian.jira.plugins:devsummarycf" },
      ],
      fieldUsage: { summary: 4, customfield_20002: 2, customfield_10000: 4, [STORY_FIELD]: 1 },
      fieldOptions: fieldOptions,
      fieldSamples: { customfield_20002: ["Alpha"], [STORY_FIELD]: ["2.5"] },
      statuses: [{ name: "To Do", categoryKey: "new" }],
      issueTypes: [{ name: "Task", subtask: false }],
      priorities: [],
      sprints: [],
      attachmentSizes: [],
      issueCount: 4,
      minKeyNumber: 1,
      maxKeyNumber: 4,
    } as unknown as JiraDiscovery;

    const preview = await withAuthorizedTenant(ctx, (tx) =>
      previewJiraMigrationPlan(tx, { organizationId: orgId, projectId, boardId }, discovery, mapping([FIELDS[0]!, FIELDS[3]!])),
    );

    const story = preview.fields.find((f) => f.jiraFieldId === STORY_FIELD)!;
    expect(story).toMatchObject({ action: "core", target: { kind: "core", coreField: "storyPoints" }, usage: 1, samples: ["2.5"] });
    const topic = preview.fields.find((f) => f.jiraFieldId === "customfield_20002")!;
    expect(topic).toMatchObject({ action: "property", target: { kind: "new", name: "Topic", type: "select" }, usage: 2, samples: ["Alpha"] });
    expect(topic.suggested).toEqual({ name: "Topic", type: "select" });

    expect(preview.handledAutomatically).toEqual(["Summary"]);
    expect(preview.notMigratable).toEqual([{ jiraName: "Development", usage: 4, reason: "dev-tool-summary" }]);
  });
});
