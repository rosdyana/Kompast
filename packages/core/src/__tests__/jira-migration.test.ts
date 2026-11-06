import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminDb as admin, schema, eq } from "@kompast/db";
import { createProject } from "../project";
import { ForbiddenError, withAuthorizedTenant } from "../permissions";
import { id } from "../ids";
import {
  claimJiraMigrations,
  createJiraMigration,
  deleteJiraMigration,
  finishJiraMigration,
  getJiraMigration,
  getJiraMigrationForProject,
  getJiraMigrationToken,
  getLatestJiraMigrationRun,
  listJiraMappingTargets,
  markJiraMigrationSynced,
  parseJiraMigrationMapping,
  releaseJiraMigrationLease,
  renewJiraMigrationLease,
  requestJiraDiscovery,
  saveJiraDiscovery,
  saveJiraMigrationMapping,
  startJiraMigrationRun,
  updateJiraMigrationCredentials,
  updateJiraMigrationProgress,
  type JiraMappingTargets,
} from "../jira-migration";

describe("JIRA migration record (core)", () => {
  const orgId = "test-jira-mig-org";
  const userId = "test-jira-mig-user";
  const outsiderId = "test-jira-mig-outsider";
  const contributorId = "test-jira-mig-contrib";
  const teamId = "test-jira-mig-team";
  const ctx = { userId, organizationId: orgId };
  const outsiderCtx = { userId: outsiderId, organizationId: orgId };
  const contributorCtx = { userId: contributorId, organizationId: orgId };
  const SECRET = "jira-secret-token";

  let projectId: string;
  let boardId: string;
  let migrationId: string;

  async function cleanup() {
    await admin.delete(schema.jiraMigration).where(eq(schema.jiraMigration.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.user).where(eq(schema.user.id, outsiderId));
    await admin.delete(schema.user).where(eq(schema.user.id, contributorId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "JIRA Migration Test Org", slug: orgId });
    await admin.insert(schema.user).values([
      { id: userId, name: "Migrator", email: `${userId}@example.com` },
      { id: outsiderId, name: "Outsider", email: `${outsiderId}@example.com` },
      { id: contributorId, name: "Contributor", email: `${contributorId}@example.com` },
    ]);
    await admin.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: outsiderId, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: contributorId, role: "member" },
    ]);
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Migration Team" });
    // Only the creator and the contributor are on the team. The outsider is a workspace member with no team, so RLS must hide the project from them.
    await admin.insert(schema.teamMember).values([
      { id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` },
      { id: `tmem-${teamId}-${contributorId}`, teamId, userId: contributorId, membershipKey: `${teamId}:${contributorId}` },
    ]);

    const project = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "jmig", name: "JIRA Mig", actorUserId: userId }));
    projectId = project.projectId;
    boardId = project.boardId;
    // The creator is the project lead (createProject). The contributor can see the project but may not manage it.
    await admin.insert(schema.projectMember).values({ id: id("pmem"), projectId, userId: contributorId, role: "contributor" });

    const created = await withAuthorizedTenant(ctx, (tx) =>
      createJiraMigration(tx, ctx, {
        projectId,
        boardId,
        siteUrl: "https://jira.example.net/",
        email: `${userId}@example.com`,
        apiToken: SECRET,
        jiraProjectKey: "JMIG",
        jiraBoardId: 3,
      }),
    );
    migrationId = created.migrationId;
  });

  afterAll(cleanup);

  it("stores the token encrypted, and it decrypts only through getJiraMigrationToken", async () => {
    const [raw] = await admin.select({ enc: schema.jiraMigration.apiTokenEncrypted }).from(schema.jiraMigration).where(eq(schema.jiraMigration.id, migrationId));
    expect(raw!.enc).toBeTruthy();
    expect(raw!.enc).not.toContain(SECRET);
    expect(await getJiraMigrationToken(admin, migrationId)).toBe(SECRET);
  });

  it("read APIs never return the token, only hasToken, and the site URL has no trailing slash", async () => {
    const m = await withAuthorizedTenant(ctx, (tx) => getJiraMigration(tx, migrationId));
    expect(m).not.toHaveProperty("apiTokenEncrypted");
    expect(m).toMatchObject({ hasToken: true, siteUrl: "https://jira.example.net", jiraProjectKey: "JMIG", jiraBoardId: 3, state: "draft" });
    expect(JSON.stringify(m)).not.toContain(SECRET);

    const byProject = await withAuthorizedTenant(ctx, (tx) => getJiraMigrationForProject(tx, projectId));
    expect(byProject).toMatchObject({ id: migrationId, hasToken: true });
  });

  it("a project can have only one migration", async () => {
    await expect(
      withAuthorizedTenant(ctx, (tx) =>
        createJiraMigration(tx, ctx, { projectId, boardId, siteUrl: "https://jira.example.net", email: "x@example.com", apiToken: "t", jiraProjectKey: "JMIG" }),
      ),
    ).rejects.toThrow(/already has a JIRA migration/);
  });

  it("the worker lease is exclusive: a second claim gets nothing while leased, and the row comes back once the lease expires", async () => {
    await withAuthorizedTenant(ctx, (tx) => requestJiraDiscovery(tx, ctx, migrationId));
    // The claim takes the two oldest eligible rows, and other test files share this table. Push our row to the front.
    await admin.update(schema.jiraMigration).set({ updatedAt: new Date("1999-01-01T00:00:00Z") }).where(eq(schema.jiraMigration.id, migrationId));

    const first = await claimJiraMigrations(admin, 60_000);
    const claimedRow = first.find((m) => m.id === migrationId);
    expect(claimedRow).toBeDefined();
    expect(claimedRow).not.toHaveProperty("apiTokenEncrypted");

    const second = await claimJiraMigrations(admin, 60_000);
    expect(second.map((m) => m.id)).not.toContain(migrationId);

    // The worker died mid-tick: the lease lapses, so the row becomes claimable again.
    await admin.update(schema.jiraMigration).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.jiraMigration.id, migrationId));
    const third = await claimJiraMigrations(admin, 60_000);
    expect(third.map((m) => m.id)).toContain(migrationId);

    // Renewing pushes the lease out again, so it's leased and skipped; releasing makes it claimable.
    await renewJiraMigrationLease(admin, migrationId, 60_000);
    expect((await claimJiraMigrations(admin, 60_000)).map((m) => m.id)).not.toContain(migrationId);
    await releaseJiraMigrationLease(admin, migrationId);
    expect((await claimJiraMigrations(admin, 60_000)).map((m) => m.id)).toContain(migrationId);
  });

  it("a workspace member outside the project's team cannot see the migration", async () => {
    expect(await withAuthorizedTenant(outsiderCtx, (tx) => getJiraMigration(tx, migrationId))).toBeNull();
    expect(await withAuthorizedTenant(outsiderCtx, (tx) => getJiraMigrationForProject(tx, projectId))).toBeNull();
    expect(await withAuthorizedTenant(ctx, (tx) => getJiraMigration(tx, migrationId))).not.toBeNull();
  });

  async function current() {
    return withAuthorizedTenant(ctx, (tx) => getJiraMigration(tx, migrationId));
  }

  async function targets(): Promise<JiraMappingTargets> {
    return withAuthorizedTenant(ctx, (tx) => listJiraMappingTargets(tx, projectId, boardId));
  }

  /** Puts the migration in "ready" the way the worker does after a scan. */
  async function markReady() {
    await withAuthorizedTenant(ctx, (tx) => requestJiraDiscovery(tx, ctx, migrationId));
    await withAuthorizedTenant(ctx, (tx) => saveJiraDiscovery(tx, migrationId, { issueCount: 4 }, {}));
  }

  function byName<T extends { name: string }>(rows: T[], name: string): T {
    const row = rows.find((r) => r.name === name);
    if (!row) throw new Error(`no row named ${name}`);
    return row;
  }

  it("only project admins can change a migration: a contributor who can see the project is refused, an outsider can't see it", async () => {
    expect(await withAuthorizedTenant(contributorCtx, (tx) => getJiraMigration(tx, migrationId))).toMatchObject({ state: "draft" });
    await expect(withAuthorizedTenant(contributorCtx, (tx) => requestJiraDiscovery(tx, contributorCtx, migrationId))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(withAuthorizedTenant(contributorCtx, (tx) => deleteJiraMigration(tx, contributorCtx, migrationId))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      withAuthorizedTenant(contributorCtx, (tx) => updateJiraMigrationCredentials(tx, contributorCtx, migrationId, { apiToken: "nope" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(withAuthorizedTenant(outsiderCtx, (tx) => requestJiraDiscovery(tx, outsiderCtx, migrationId))).rejects.toThrow(/not found/);
    expect(await getJiraMigrationToken(admin, migrationId)).toBe(SECRET);
  });

  it("the creator can replace the token, and it decrypts to the new value", async () => {
    await withAuthorizedTenant(ctx, (tx) => updateJiraMigrationCredentials(tx, ctx, migrationId, { email: "new@example.com", apiToken: "rotated" }));
    expect(await getJiraMigrationToken(admin, migrationId)).toBe("rotated");
    expect(await current()).toMatchObject({ email: "new@example.com", hasToken: true });
  });

  it("requestJiraDiscovery starts a scan from draft with discovery progress; delete, finish and mapping are refused in the wrong state", async () => {
    await withAuthorizedTenant(ctx, (tx) => requestJiraDiscovery(tx, ctx, migrationId));
    expect(await current()).toMatchObject({ state: "discovering", error: null, progress: { phase: "discovery", done: 0, total: null } });

    await updateJiraMigrationProgress(admin, migrationId, { phase: "discovery", done: 7, total: null });
    expect(await current()).toMatchObject({ progress: { phase: "discovery", done: 7, total: null } });

    await expect(withAuthorizedTenant(ctx, (tx) => deleteJiraMigration(tx, ctx, migrationId))).rejects.toThrow(/Cannot delete the migration while it is "discovering"/);
    await expect(withAuthorizedTenant(ctx, (tx) => saveJiraMigrationMapping(tx, ctx, migrationId, {}))).rejects.toThrow(/Cannot change the mapping while/);
    await expect(withAuthorizedTenant(ctx, (tx) => finishJiraMigration(tx, ctx, migrationId))).rejects.toThrow(/Only a synced migration/);
    await expect(withAuthorizedTenant(ctx, (tx) => requestJiraDiscovery(tx, ctx, migrationId))).rejects.toThrow(/Cannot scan JIRA while/);
  });

  it("listJiraMappingTargets lists the project's statuses, types, members, board columns and its own priority levels", async () => {
    const t = await targets();
    expect(t.statuses.map((s) => s.name)).toEqual(["Backlog", "To Do", "In Progress", "In Review", "Done"]);
    expect(t.columns.map((c) => [c.name, c.order, c.statusIds.length])).toEqual([
      ["Backlog", 0, 1],
      ["To Do", 1, 1],
      ["In Progress", 2, 1],
      ["In Review", 3, 1],
      ["Done", 4, 1],
    ]);
    expect(t.types.length).toBeGreaterThan(0);
    // Project lead and the team's contributor are members; the outsider is neither.
    expect(t.members.map((m) => m.userId).sort()).toEqual([contributorId, userId].sort());
    // createProject seeds the default levels, in order.
    expect(t.priorities).toEqual([
      { key: "very_low", name: "Very Low" },
      { key: "low", name: "Low" },
      { key: "medium", name: "Medium" },
      { key: "high", name: "High" },
      { key: "critical", name: "Critical" },
    ]);
  });

  it("saveJiraMigrationMapping validates against the project and board, drops unknown keys, and refuses bad values", async () => {
    await markReady();
    const t = await targets();
    const colInProgress = byName(t.columns, "In Progress");
    const colDone = byName(t.columns, "Done");
    const good = {
      statuses: [
        { jiraName: "To Do", category: "todo", action: "map", kompastStatusId: byName(t.statuses, "To Do").id },
        { jiraName: "Blocked", category: "in_progress", action: "create", column: { mode: "new", afterColumnId: colInProgress.id }, junk: true },
        { jiraName: "Shipped", category: "done", action: "create", column: { mode: "join", columnId: colDone.id } },
      ],
      types: [{ jiraName: "Task", action: "map", kompastTypeId: t.types[0]!.id }],
      people: [
        { accountId: "acc-1", displayName: "Migrator", action: "map", kompastUserId: userId, confidence: "email" },
        { accountId: "acc-2", displayName: "Gone", action: "former", confidence: "none", kompastUserId: "ignored" },
      ],
      priorities: [
        { jiraName: "Highest", kompastKey: "critical", extra: 1 },
        { jiraName: "Lowest", kompastKey: "very_low" },
      ],
      attachmentMaxBytes: null,
      extra: "dropped",
    };
    await withAuthorizedTenant(ctx, (tx) => saveJiraMigrationMapping(tx, ctx, migrationId, good));

    expect((await current())?.mapping).toEqual({
      statuses: [
        { jiraName: "To Do", category: "todo", action: "map", kompastStatusId: byName(t.statuses, "To Do").id },
        { jiraName: "Blocked", category: "in_progress", action: "create", column: { mode: "new", afterColumnId: colInProgress.id } },
        { jiraName: "Shipped", category: "done", action: "create", column: { mode: "join", columnId: colDone.id } },
      ],
      types: [{ jiraName: "Task", action: "map", kompastTypeId: t.types[0]!.id }],
      people: [
        { accountId: "acc-1", displayName: "Migrator", action: "map", kompastUserId: userId, confidence: "email" },
        { accountId: "acc-2", displayName: "Gone", action: "former", confidence: "none" },
      ],
      priorities: [
        { jiraName: "Highest", kompastKey: "critical" },
        { jiraName: "Lowest", kompastKey: "very_low" },
      ],
      attachmentMaxBytes: null,
    });

    const bad: Array<[unknown, RegExp]> = [
      [{ ...good, priorities: [{ jiraName: "Blocker", kompastKey: "blocker" }] }, /not in this project/],
      [{ ...good, priorities: [{ jiraName: "Highest", kompastKey: "" }] }, /choose a Kompast priority/],
      [{ ...good, priorities: "Highest" }, /priorities list is malformed/],
      [{ ...good, statuses: [{ jiraName: "X", category: "todo", action: "map", kompastStatusId: "not-a-status" }] }, /not in this project/],
      [{ ...good, statuses: [{ jiraName: "X", category: "todo", action: "create", column: { mode: "join", columnId: "col-elsewhere" } }] }, /must name a column of this board/],
      [{ ...good, people: [{ accountId: "a", displayName: "Outsider", action: "map", kompastUserId: outsiderId, confidence: "name" }] }, /not a member/],
      [{ ...good, attachmentMaxBytes: 0 }, /between 1 and 2 GB/],
      [{ ...good, attachmentMaxBytes: 3 * 1024 ** 3 }, /between 1 and 2 GB/],
      [{ ...good, attachmentMaxBytes: 1.5 }, /between 1 and 2 GB/],
      [{ ...good, statuses: [{ jiraName: "X", category: "blue", action: "create" }] }, /to do, in progress or done/],
    ];
    for (const [mapping, message] of bad) {
      await expect(withAuthorizedTenant(ctx, (tx) => saveJiraMigrationMapping(tx, ctx, migrationId, mapping))).rejects.toThrow(message);
    }
    // A refused save leaves the stored mapping alone.
    expect((await current())?.mapping).toMatchObject({ attachmentMaxBytes: null, statuses: expect.arrayContaining([expect.objectContaining({ jiraName: "Blocked" })]) });
  });

  it("a run starts from ready with a saved mapping, and finish then delete follow the synced/completed rules", async () => {
    await markReady();
    const t = await targets();
    await withAuthorizedTenant(ctx, (tx) =>
      saveJiraMigrationMapping(tx, ctx, migrationId, {
        statuses: [{ jiraName: "To Do", category: "todo", action: "map", kompastStatusId: byName(t.statuses, "To Do").id }],
        types: [],
        people: [],
        attachmentMaxBytes: 10 * 1024 * 1024,
      }),
    );

    await expect(withAuthorizedTenant(contributorCtx, (tx) => startJiraMigrationRun(tx, contributorCtx, migrationId))).rejects.toBeInstanceOf(ForbiddenError);
    const { importRunId } = await withAuthorizedTenant(ctx, (tx) => startJiraMigrationRun(tx, ctx, migrationId));
    expect(await current()).toMatchObject({ state: "running" });
    expect(await withAuthorizedTenant(ctx, (tx) => getLatestJiraMigrationRun(tx, migrationId))).toMatchObject({ id: importRunId, status: "pending", errorCount: 0 });

    await expect(withAuthorizedTenant(ctx, (tx) => finishJiraMigration(tx, ctx, migrationId))).rejects.toThrow(/Only a synced migration/);
    await withAuthorizedTenant(ctx, (tx) => markJiraMigrationSynced(tx, migrationId, new Date()));
    // Finishing needs a completed reconcile that finished after the last sync (see jira-reconcile.test.ts for a real one).
    await expect(withAuthorizedTenant(ctx, (tx) => finishJiraMigration(tx, ctx, migrationId))).rejects.toThrow(/Check completeness/);
    await admin.insert(schema.importRun).values({
      id: id("imprun"),
      organizationId: orgId,
      projectId,
      source: "jira",
      dryRun: false,
      status: "completed",
      config: { mode: "reconcile" },
      counts: { title: { jira: 1, kompast: 1, matched: 1, explained: 0, unexplained: 0 } },
      errors: [],
      notes: { differences: [], truncated: 0, clean: true },
      createdBy: userId,
      migrationId,
      completedAt: new Date(Date.now() + 1000),
    });
    await withAuthorizedTenant(ctx, (tx) => finishJiraMigration(tx, ctx, migrationId));
    expect(await current()).toMatchObject({ state: "completed", hasToken: false, autoSyncMinutes: null });

    await withAuthorizedTenant(ctx, (tx) => deleteJiraMigration(tx, ctx, migrationId));
    expect(await current()).toBeNull();
    // Imported work stays as the run history; only the link back to the migration is cleared.
    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
    expect(run).toMatchObject({ migrationId: null, status: "pending" });
  });
});

describe("parseJiraMigrationMapping (pure)", () => {
  const targets: JiraMappingTargets = {
    statuses: [{ id: "st-1", name: "To Do", category: "todo" }],
    types: [{ id: "ty-1", name: "Task" }],
    members: [{ userId: "u-1", name: "Ann", email: null }],
    columns: [{ id: "col-1", name: "To Do", order: 0, statusIds: ["st-1"] }],
    priorities: [
      { key: "low", name: "Low" },
      { key: "medium", name: "Medium" },
    ],
  };
  const empty = { statuses: [], types: [], people: [], priorities: [], attachmentMaxBytes: 1024 };

  it("accepts an empty mapping, a 'no limit' attachment setting, and an after-column placement of null", () => {
    expect(parseJiraMigrationMapping(empty, targets)).toEqual(empty);
    expect(parseJiraMigrationMapping({ ...empty, attachmentMaxBytes: null }, targets).attachmentMaxBytes).toBeNull();
    const placed = parseJiraMigrationMapping(
      { ...empty, statuses: [{ jiraName: "Triage", category: "todo", action: "create", column: { mode: "new", afterColumnId: null } }] },
      targets,
    );
    expect(placed.statuses[0]).toEqual({ jiraName: "Triage", category: "todo", action: "create", column: { mode: "new", afterColumnId: null } });
  });

  it("keeps priority choices that name a project level, and reads a mapping saved without priorities as an empty list", () => {
    const withPriority = parseJiraMigrationMapping({ ...empty, priorities: [{ jiraName: "Trivial", kompastKey: "low", junk: true }] }, targets);
    expect(withPriority.priorities).toEqual([{ jiraName: "Trivial", kompastKey: "low" }]);
    const { priorities: _dropped, ...legacy } = empty;
    expect(parseJiraMigrationMapping(legacy, targets).priorities).toEqual([]);
    expect(() => parseJiraMigrationMapping({ ...empty, priorities: [{ jiraName: "Trivial", kompastKey: "very_low" }] }, targets)).toThrow(/not in this project/);
  });

  it("rejects a non-object, missing lists, an unknown column mode, and a column placement without a valid id", () => {
    expect(() => parseJiraMigrationMapping(null, targets)).toThrow(/must be an object/);
    expect(() => parseJiraMigrationMapping({ statuses: [] }, targets)).toThrow(/needs statuses, types and people/);
    expect(() =>
      parseJiraMigrationMapping({ ...empty, statuses: [{ jiraName: "X", category: "todo", action: "create", column: { mode: "merge" } }] }, targets),
    ).toThrow(/needs mode "new" or "join"/);
    expect(() =>
      parseJiraMigrationMapping({ ...empty, statuses: [{ jiraName: "X", category: "todo", action: "create", column: { mode: "new", afterColumnId: "col-9" } }] }, targets),
    ).toThrow(/must name a column of this board, or be the start/);
  });
});

describe("parseJiraMigrationMapping: fields (pure)", () => {
  const fieldTargets: JiraMappingTargets = {
    statuses: [],
    types: [],
    members: [],
    columns: [],
    priorities: [],
    properties: [
      { key: "topic", name: "Topic", type: "select", isCore: false },
      { key: "count", name: "Count", type: "number", isCore: false },
      { key: "startDate", name: "Start date", type: "date", isCore: true },
    ],
  };
  const base = { statuses: [], types: [], people: [], priorities: [], attachmentMaxBytes: null };
  const withFields = (fields: unknown) => ({ ...base, fields });

  it("keeps each field's choice: a core target, an existing property, a new number with a transform, and a skip", () => {
    const parsed = parseJiraMigrationMapping(
      withFields([
        { jiraFieldId: "customfield_1", jiraName: "Story points", action: "core", coreField: "storyPoints", junk: 1 },
        { jiraFieldId: "customfield_2", jiraName: "Topic", action: "property", propertyKey: "topic" },
        { jiraFieldId: "timeestimate", jiraName: "Remaining Estimate", action: "property", create: { name: " Remaining estimate (h) ", type: "number" }, transform: "secondsToHours" },
        { jiraFieldId: "customfield_3", jiraName: "Color", action: "skip", propertyKey: "topic" },
        { jiraFieldId: "customfield_4", jiraName: "Hours", action: "property", propertyKey: "count", transform: "secondsToHours" },
      ]),
      fieldTargets,
    );
    expect(parsed.fields).toEqual([
      { jiraFieldId: "customfield_1", jiraName: "Story points", action: "core", coreField: "storyPoints" },
      { jiraFieldId: "customfield_2", jiraName: "Topic", action: "property", propertyKey: "topic" },
      { jiraFieldId: "timeestimate", jiraName: "Remaining Estimate", action: "property", create: { name: "Remaining estimate (h)", type: "number" }, transform: "secondsToHours" },
      { jiraFieldId: "customfield_3", jiraName: "Color", action: "skip" },
      { jiraFieldId: "customfield_4", jiraName: "Hours", action: "property", propertyKey: "count", transform: "secondsToHours" },
    ]);
  });

  it("a mapping saved without a fields list parses without one", () => {
    expect(parseJiraMigrationMapping(base, fieldTargets)).not.toHaveProperty("fields");
  });

  it("refuses a core target used twice, an unknown core field, a property not in the project (or a core one), and a field listed twice", () => {
    const core = (jiraFieldId: string, coreField: string) => ({ jiraFieldId, jiraName: jiraFieldId, action: "core", coreField });
    const bad: Array<[unknown[], RegExp]> = [
      [[core("a", "storyPoints"), core("b", "storyPoints")], /already fills this core field/],
      [[core("a", "estimate")], /choose a core field/],
      [[{ jiraFieldId: "a", jiraName: "A", action: "property", propertyKey: "gone" }], /not in this project/],
      [[{ jiraFieldId: "a", jiraName: "A", action: "property", propertyKey: "startDate" }], /not in this project/],
      [[{ jiraFieldId: "a", jiraName: "A", action: "skip" }, { jiraFieldId: "a", jiraName: "A", action: "skip" }], /listed twice/],
    ];
    for (const [fields, message] of bad) {
      expect(() => parseJiraMigrationMapping(withFields(fields), fieldTargets)).toThrow(message);
    }
  });

  it("refuses a new property with a reserved name (jira, or a core property's name), an over-long name, an unknown type, or no name", () => {
    const create = (name: string, type = "text") => [{ jiraFieldId: "a", jiraName: "A", action: "property", create: { name, type } }];
    const bad: Array<[unknown[], RegExp]> = [
      [create("jira"), /reserved name/],
      [create("  JIRA "), /reserved name/],
      [create("Start date", "date"), /reserved name/],
      [create("x".repeat(81)), /longer than 80 characters/],
      [create("Colour", "color"), /not one Kompast has/],
      [create("   "), /name the new property/],
    ];
    for (const [fields, message] of bad) {
      expect(() => parseJiraMigrationMapping(withFields(fields), fieldTargets)).toThrow(message);
    }
  });

  it("a transform only applies to a number property, and it's the only transform there is", () => {
    const bad: Array<[unknown[], RegExp]> = [
      [[{ jiraFieldId: "a", jiraName: "A", action: "property", create: { name: "Notes", type: "text" }, transform: "secondsToHours" }], /only applies to a number property/],
      [[{ jiraFieldId: "a", jiraName: "A", action: "property", propertyKey: "topic", transform: "secondsToHours" }], /only applies to a number property/],
      [[{ jiraFieldId: "a", jiraName: "A", action: "core", coreField: "storyPoints", transform: "secondsToHours" }], /only applies to a number property/],
      [[{ jiraFieldId: "a", jiraName: "A", action: "property", propertyKey: "count", transform: "hours" }], /only transform is secondsToHours/],
    ];
    for (const [fields, message] of bad) {
      expect(() => parseJiraMigrationMapping(withFields(fields), fieldTargets)).toThrow(message);
    }
  });

  it("a property action needs a property to write into or a new one to create, and the action must be known", () => {
    expect(() => parseJiraMigrationMapping(withFields([{ jiraFieldId: "a", jiraName: "A", action: "property" }]), fieldTargets)).toThrow(/choose a property or create one/);
    expect(() => parseJiraMigrationMapping(withFields([{ jiraFieldId: "a", jiraName: "A", action: "map" }]), fieldTargets)).toThrow(/must be "core", "property" or "skip"/);
  });
});
