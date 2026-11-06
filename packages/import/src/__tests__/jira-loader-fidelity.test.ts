import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, and, inArray, adminDb as admin } from "@kompast/db";
import {
  createImportRun,
  createIssue,
  createProject,
  formerMemberEmail,
  resolveExternalRef,
  withAuthorizedTenant,
} from "@kompast/core";
import { id } from "@kompast/core/ids";
import { finalizeJiraImport, loadJiraIssueBatch, prepareJiraImport, resolveUserFromMapping, type JiraLoadContext } from "../jira/load";
import type { JiraMigrationMapping } from "../jira/mapping";
import type { JiraIssue, JiraChangelogHistory } from "../jira/types";

/**
 * The loader's fidelity pass against real Postgres, with JIRA reduced to plain
 * objects (nothing here calls JIRA). Covers what the earlier loader dropped:
 * key numbers, former-member attribution, per-issue savepoints, watchers,
 * timestamps and resolution, field history, and issue mentions.
 */
describe("JIRA loader fidelity (real Postgres)", () => {
  const orgId = "test-jira-fidelity-org";
  const userId = "test-jira-fidelity-user";
  const teamId = "test-jira-fidelity-team";
  const ctx = { userId, organizationId: orgId };
  const BASE = "https://acme.atlassian.net";
  const STORY_FIELD = "customfield_10016";

  const GONE = { accountId: "557058:zfid-gone", displayName: "Gone Person" };
  const ANN = { accountId: "acc-ann", displayName: "Ann Lee", emailAddress: `${userId}@example.com`, active: true, accountType: "atlassian" };

  let projectId: string;
  let boardId: string;
  let typeId: string;
  let statusId: string;

  const formerEmails = [formerMemberEmail(GONE.accountId)];

  async function cleanup() {
    // Issues reference the placeholder users (reporter, assignee), so the project goes first.
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.user).where(inArray(schema.user.email, formerEmails));
    await admin.delete(schema.externalRef).where(eq(schema.externalRef.organizationId, orgId));
    await admin.delete(schema.importRun).where(eq(schema.importRun.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "JIRA Fidelity Loader Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "Ann Lee", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Loader Team" });
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });
    const project = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "ZFID", name: "Loader Fidelity", actorUserId: userId }));
    projectId = project.projectId;
    boardId = project.boardId;
    const [status] = await admin.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, projectId)).limit(1);
    const [type] = await admin.select().from(schema.issueType).where(eq(schema.issueType.projectId, projectId)).limit(1);
    statusId = status!.id;
    typeId = type!.id;
  });

  afterAll(cleanup);

  function mapping(people: JiraMigrationMapping["people"]): JiraMigrationMapping {
    return { statuses: [], types: [], people, priorities: [], attachmentMaxBytes: null };
  }

  const ANN_MAPPED = { accountId: ANN.accountId, displayName: ANN.displayName, action: "map" as const, kompastUserId: userId, confidence: "email" as const };
  const GONE_FORMER = { accountId: GONE.accountId, displayName: GONE.displayName, action: "former" as const, confidence: "none" as const };

  /**
   * One import pass over the given issues, as the runner does it: prepare, one batch,
   * finalize. Runs in one tenant transaction, like a page.
   */
  async function importIssues(issues: JiraIssue[], people: JiraMigrationMapping["people"] = [ANN_MAPPED, GONE_FORMER], overrides: Partial<JiraLoadContext> = {}) {
    const importRunId = (await withAuthorizedTenant(ctx, (tx) =>
      createImportRun(tx, { organizationId: orgId, projectId, source: "jira", dryRun: false, config: {}, createdBy: userId }),
    )).importRunId;
    const base: JiraLoadContext = {
      organizationId: orgId,
      projectId,
      boardId,
      importRunId,
      actorUserId: userId,
      dryRun: false,
      jiraBaseUrl: BASE,
      jiraProjectKey: "ZFID",
      storyPointsFieldId: STORY_FIELD,
      ...overrides,
    };
    const input = { statuses: [{ name: "To Do", categoryKey: "new" }, { name: "Done", categoryKey: "done" }], types: [{ name: "Task" }], sprints: [], mapping: mapping(people) };
    return withAuthorizedTenant(ctx, async (tx) => {
      const prepared = await prepareJiraImport(tx, base, input);
      const loadCtx: JiraLoadContext = { ...base, resolveUserId: resolveUserFromMapping(input.mapping, prepared.formerUserIdByAccount) };
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

  function jiraIssue(key: string, fields: Partial<JiraIssue["fields"]> = {}, extra: Partial<JiraIssue> = {}): JiraIssue {
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
      } as JiraIssue["fields"],
      ...extra,
    };
  }

  it("keeps JIRA's number when it's free; when a manual issue holds it, the issue takes the next free number and a note (not an error) says so", async () => {
    await withAuthorizedTenant(ctx, (tx) => createIssue(tx, { organizationId: orgId, projectId, typeId, statusId, title: "manual", reporterId: userId }));

    const { batch } = await importIssues([jiraIssue("ZFID-1")]);
    expect(batch.counts.issuesRenumbered).toBe(1);
    expect(batch.errors).toEqual([]);
    expect(batch.notes).toEqual([{ issueKey: "ZFID-1", note: expect.stringMatching(/^renumbered to \S+-2: number already used$/) }]);
    const row = await rowFor("ZFID-1");
    expect(row.keySeq).toBe(2);
  });

  it("attributes a former member's reporter, assignee, comment and watch to their placeholder user, and sends no notification", async () => {
    const issue = jiraIssue("ZFID-10", {
      reporter: GONE,
      assignee: GONE,
      comment: { comments: [{ id: "c1", author: GONE, body: "hello", created: "2024-01-02T00:00:00.000+0000" }], total: 1 },
    });
    const { prepared } = await importIssues([issue]);

    const placeholder = prepared.formerUserIdByAccount?.[GONE.accountId];
    expect(placeholder).toBeTruthy();
    expect(prepared.counts.formerMembersCreated).toBe(1);

    const row = await rowFor("ZFID-10");
    expect(row.reporterId).toBe(placeholder);
    expect(row.assigneeId).toBe(placeholder);
    const [comment] = await admin.select().from(schema.issueComment).where(eq(schema.issueComment.issueId, row.id));
    expect(comment!.authorId).toBe(placeholder);

    const notifications = await admin.select().from(schema.notification).where(eq(schema.notification.organizationId, orgId));
    expect(notifications).toHaveLength(0);
  });

  it("writes an issue whose step fails in its own savepoint: the failing issue is reported, its neighbours are created, and the page's transaction commits", async () => {
    const issues = [
      jiraIssue("ZFID-20"),
      // A NUL byte is something Postgres refuses in text, so this insert fails at the database.
      jiraIssue("ZFID-21", { summary: "bad\u0000title" }),
      jiraIssue("ZFID-22"),
    ];
    const { batch } = await importIssues(issues);

    expect(batch.counts.issuesCreated).toBe(2);
    expect(batch.errors.map((e) => e.issueKey)).toEqual(["ZFID-21"]);
    expect(await resolveExternalRef(admin as never, orgId, "jira", "ZFID-21")).toBeNull();
    // Committed: the neighbours are visible from outside the page's transaction.
    expect((await rowFor("ZFID-20")).title).toBe("ZFID-20 summary");
    expect((await rowFor("ZFID-22")).title).toBe("ZFID-22 summary");
  });

  it("records watchers who are mapped members, and skips former members and unknown accounts", async () => {
    const issue = jiraIssue("ZFID-30", {}, {
      watchersList: [ANN, GONE, { accountId: "acc-unknown", displayName: "Nobody", active: true, accountType: "atlassian" }],
    });
    const { batch } = await importIssues([issue]);

    expect(batch.counts.watchersAdded).toBe(1);
    expect(batch.counts.watchersSkipped).toBe(2);
    const row = await rowFor("ZFID-30");
    const watchers = await admin.select().from(schema.issueWatcher).where(eq(schema.issueWatcher.issueId, row.id));
    expect(watchers.map((w) => w.userId)).toEqual([userId]);
  });

  it("sets updated_at from JIRA and resolved_at from its resolution date, even after later writes (worklogs) in the same import", async () => {
    const issue = jiraIssue("ZFID-40", {
      updated: "2024-06-01T00:00:00.000+0000",
      resolutiondate: "2024-06-02T00:00:00.000+0000",
      resolution: { name: "Done" },
      worklog: { worklogs: [{ id: "w1", author: ANN, timeSpentSeconds: 3600, started: "2024-05-01T00:00:00.000+0000" }], total: 1 },
      [STORY_FIELD]: 2.5,
    } as Partial<JiraIssue["fields"]>);
    const { batch } = await importIssues([issue]);
    expect(batch.errors).toEqual([]);

    const row = await rowFor("ZFID-40");
    expect(row.updatedAt.toISOString()).toBe("2024-06-01T00:00:00.000Z");
    expect(row.resolvedAt?.toISOString()).toBe("2024-06-02T00:00:00.000Z");
    expect(row.customFields).toMatchObject({ jira: { resolution: "Done" } });
    // JIRA's 2.5 rounds into the integer column.
    expect(row.storyPoints).toBe(3);
  });

  it("keeps the child's JIRA updated time when its parent link is only resolved at finalize", async () => {
    const child = jiraIssue("ZFID-50", { updated: "2024-07-01T00:00:00.000+0000", parent: { key: "ZFID-51" } });
    const parent = jiraIssue("ZFID-51");
    const importRunId = (await withAuthorizedTenant(ctx, (tx) =>
      createImportRun(tx, { organizationId: orgId, projectId, source: "jira", dryRun: false, config: {}, createdBy: userId }),
    )).importRunId;
    const base: JiraLoadContext = { organizationId: orgId, projectId, boardId, importRunId, actorUserId: userId, dryRun: false, jiraBaseUrl: BASE, jiraProjectKey: "ZFID" };
    const input = { statuses: [{ name: "To Do", categoryKey: "new" }], types: [{ name: "Task" }], sprints: [] };
    await withAuthorizedTenant(ctx, async (tx) => {
      const prepared = await prepareJiraImport(tx, base, input);
      const first = await loadJiraIssueBatch(tx, [child], base, prepared);
      const second = await loadJiraIssueBatch(tx, [parent], base, prepared);
      expect(first.deferredParents).toEqual([
        {
          childKey: "ZFID-50",
          parentKey: "ZFID-51",
          updatedAt: "2024-07-01T00:00:00.000+0000",
          createdAt: "2024-01-01T00:00:00.000+0000",
          historyActorId: userId,
        },
      ]);
      await finalizeJiraImport(tx, base, prepared, { deferredParents: first.deferredParents, deferredLinks: [...first.deferredLinks, ...second.deferredLinks] });
    });

    const childRow = await rowFor("ZFID-50");
    const parentRow = await rowFor("ZFID-51");
    expect(childRow.parentId).toBe(parentRow.id);
    expect(childRow.updatedAt.toISOString()).toBe("2024-07-01T00:00:00.000Z");
    // The parent link's history row is dated to the child's JIRA created time, not to the import run.
    const parentEntries = (await admin.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, childRow.id))).filter((e) => e.field === "parentId");
    expect(parentEntries).toHaveLength(1);
    expect(parentEntries[0]!.createdAt.getTime()).toBe(Date.UTC(2024, 0, 1));
    expect(parentEntries[0]!.origin).toBe("import");
  });

  it("dates a same-batch parent link's history to the child's JIRA created time, attributed to the child's reporter rather than the importer", async () => {
    const child = jiraIssue("ZFID-52", { created: "2023-05-06T08:00:00.000+0000", reporter: GONE, parent: { key: "ZFID-53" } });
    const parent = jiraIssue("ZFID-53");
    const { prepared, batch } = await importIssues([child, parent]);
    expect(batch.errors).toEqual([]);

    const childRow = await rowFor("ZFID-52");
    const parentRow = await rowFor("ZFID-53");
    expect(childRow.parentId).toBe(parentRow.id);
    const entries = (await admin.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, childRow.id))).filter((e) => e.field === "parentId");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.createdAt.getTime()).toBe(Date.UTC(2023, 4, 6, 8));
    expect(entries[0]!.actorId).toBe(prepared.formerUserIdByAccount?.[GONE.accountId]);
    expect(entries[0]!.actorId).not.toBe(userId);
  });

  it("records each JIRA changelog change as issue history with the right field name, value and actor, backdated to the change", async () => {
    const history = (created: string, items: JiraChangelogHistory["items"]): JiraChangelogHistory => ({ created, author: ANN, items });
    const issue = jiraIssue("ZFID-60", {}, {
      changelog: {
        histories: [
          history("2024-03-01T00:00:00.000+0000", [
            { field: "status", fromString: "To Do", toString: "Done", from: "1", to: "3" },
            { field: "assignee", from: null, fromString: null, to: ANN.accountId, toString: ANN.displayName },
            { field: "priority", fromString: "Medium", toString: "High" },
            { field: "duedate", fromString: null, toString: "2024-04-01" },
            { field: "summary", fromString: "Old title", toString: "New title" },
            { field: "labels", fromString: null, toString: "alpha beta" },
            { field: "Sprint", from: "", fromString: null, to: "777", toString: "Sprint 777" },
            { field: "resolution", fromString: null, toString: "Done" },
            { field: "Story point estimate", fieldId: STORY_FIELD, fromString: null, toString: "3" },
          ]),
        ],
        total: 1,
      },
    });
    const { batch } = await importIssues([issue], [ANN_MAPPED, GONE_FORMER], {});
    expect(batch.errors).toEqual([]);
    // Status keeps its own counter; the rest of the list is history entries.
    expect(batch.counts.historicalTransitionsRecorded).toBe(1);
    expect(batch.counts.historyEntriesRecorded).toBe(8);

    const row = await rowFor("ZFID-60");
    const entries = await admin.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, row.id));
    const byField = (field: string) => entries.find((e) => e.field === field);

    // The status change keeps its own path: from/to are status ids, and the actor is the JIRA author (ANN, mapped to the importer).
    expect(byField("status")).toMatchObject({ fromValue: expect.any(String), toValue: expect.any(String), origin: "import", actorId: userId });
    expect(byField("assigneeId")).toMatchObject({ fromValue: null, toValue: userId });
    expect(byField("priority")).toMatchObject({ fromValue: "medium", toValue: "high" });
    expect(byField("dueDate")).toMatchObject({ fromValue: null, toValue: "2024-04-01T00:00:00.000Z" });
    expect(byField("title")).toMatchObject({ fromValue: "Old title", toValue: "New title" });
    expect(byField("labels")).toMatchObject({ fromValue: null, toValue: "alpha, beta" });
    // Sprint 777 wasn't imported, so the change keeps JIRA's names under jira.Sprint.
    expect(byField("jira.Sprint")).toMatchObject({ fromValue: null, toValue: "Sprint 777" });
    expect(byField("jira.resolution")).toMatchObject({ fromValue: null, toValue: "Done" });
    expect(byField("storyPoints")).toMatchObject({ fromValue: null, toValue: "3" });
    for (const entry of entries.filter((e) => e.field !== "status" && e.field !== "created")) {
      expect(entry.createdAt.toISOString()).toBe("2024-03-01T00:00:00.000Z");
    }
  });

  it("points each issue mention at the imported issue its JIRA key names, and leaves an unimported key as a link to JIRA", async () => {
    const card = (key: string) => ({ type: "inlineCard", attrs: { url: `${BASE}/browse/${key}` } });
    const target = jiraIssue("ZFID-70", { summary: "Target story" });
    const linker = jiraIssue("ZFID-71", {
      description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [card("ZFID-70"), { type: "text", text: " and " }, card("ZFID-99")] }] },
      comment: {
        comments: [{ id: "c9", author: ANN, body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [card("ZFID-70")] }] }, created: "2024-01-03T00:00:00.000+0000" }],
        total: 1,
      },
    });

    const { fin } = await importIssues([target, linker]);
    expect(fin.counts.issueMentionsResolved).toBe(2);
    expect(fin.counts.issueMentionsUnresolved).toBe(1);

    const targetRow = await rowFor("ZFID-70");
    const linkerRow = await rowFor("ZFID-71");
    const blocks = linkerRow.descriptionJson as unknown as { content: { type: string; props?: Record<string, string>; href?: string; content?: { text: string }[] }[] }[];
    const inline = blocks[0]!.content;
    expect(inline[0]).toMatchObject({ type: "issueMention", props: { issueId: targetRow.id, keySeq: String(targetRow.keySeq), title: "Target story", projectKey: expect.any(String) } });
    expect(inline[2]).toMatchObject({ type: "link", href: `${BASE}/browse/ZFID-99`, content: [{ text: "ZFID-99" }] });

    const [comment] = await admin.select().from(schema.issueComment).where(eq(schema.issueComment.issueId, linkerRow.id));
    const commentBlocks = comment!.bodyJson as unknown as { content: { type: string; props?: Record<string, string> }[] }[];
    expect(commentBlocks[0]!.content[0]).toMatchObject({ type: "issueMention", props: { issueId: targetRow.id } });
  });

  it("writes a story-point-free issue with its JIRA description as BlockNote blocks, with the attachment reference kept", async () => {
    const issue = jiraIssue("ZFID-80", {
      description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Body", marks: [{ type: "strong" }] }] }] },
      attachment: [{ id: "10001", filename: "shot.png", mimeType: "image/png", size: 10, content: `${BASE}/rest/api/3/attachment/content/10001` }],
    });
    await importIssues([issue]);
    const row = await rowFor("ZFID-80");
    expect(row.descriptionJson).toEqual([expect.objectContaining({ type: "paragraph", content: [{ type: "text", text: "Body", styles: { bold: true } }] })]);
    const refs = await admin.select().from(schema.externalRef).where(eq(schema.externalRef.organizationId, orgId));
    expect(refs.map((r) => r.sourceId)).toContain("ZFID-80");
  });

  it("records a former member's placeholder for the assignee's history too, and the placeholder reads as a real user row", async () => {
    const placeholder = await withAuthorizedTenant(ctx, (tx) => resolveExternalRef(tx, orgId, "jira", GONE.accountId));
    expect(placeholder).toBeNull();
    const issue = jiraIssue("ZFID-90", {}, {
      changelog: {
        histories: [{ created: "2024-02-01T00:00:00.000+0000", author: ANN, items: [{ field: "assignee", from: null, fromString: null, to: GONE.accountId, toString: GONE.displayName }] }],
        total: 1,
      },
    });
    const { prepared } = await importIssues([issue]);
    const row = await rowFor("ZFID-90");
    const entry = (await admin.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, row.id))).find((e) => e.field === "assigneeId");
    expect(entry?.toValue).toBe(prepared.formerUserIdByAccount?.[GONE.accountId]);
    const [user] = await admin.select().from(schema.user).where(eq(schema.user.id, entry!.toValue!));
    expect(user?.email).toBe(formerMemberEmail(GONE.accountId));
  });
});
