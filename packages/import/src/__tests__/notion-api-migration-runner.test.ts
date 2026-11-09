import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminDb as admin, and, eq, inArray, schema } from "@kompast/db";
import {
  createNotionMigration,
  getNotionMigration,
  requestNotionDiscovery,
  saveNotionSelection,
  startNotionMigrationRun,
  withAuthorizedTenant,
  type AuthContext,
  type NotionMigrationPublic,
} from "@kompast/core";
import { id } from "@kompast/core/ids";
import { blocksToYDocState, yDocStateToBlocks } from "@kompast/editor";
import { runNotionMigrationTick, type NotionMigrationCursor, type NotionMigrationRunnerDeps } from "../notion-api/migration-runner";
import type { NotionBlock, NotionDatabase, NotionPage, NotionSearchResult, NotionUser } from "../notion-api/types";
import { fakeNotion, type FakeNotionData } from "./notion-api-fake";

/**
 * The Notion API migration end to end: real Postgres, the real block
 * converter and blocksToYDocState, and a fake Notion server behind the real
 * client. Ticks are driven directly (no claim), so each test owns its row.
 * Run serially in-file: the fixtures share one org.
 */

// Notion ids (dashed, as the API returns them). Only the migration test uses these.
const R = "10000000-0000-4000-8000-000000000001"; // Handbook, a workspace-level page
const C = "10000000-0000-4000-8000-000000000002"; // Onboarding, child of R, mentioned by G
const G = "10000000-0000-4000-8000-000000000003"; // Laptop setup, child of C, has the mention and a user mention
const DB = "10000000-0000-4000-8000-000000000004"; // Projects, an inline database under R
const DS = "10000000-0000-4000-8000-000000000005"; // Projects' data source
const ROW1 = "10000000-0000-4000-8000-000000000006"; // Alpha
const ROW2 = "10000000-0000-4000-8000-000000000007"; // Beta
const NESTED = "10000000-0000-4000-8000-000000000009"; // Under a toggle: parent is a block inside R
const TOG = "10000000-0000-4000-8000-00000000000a"; // the toggle block in R
const BROKEN = "10000000-0000-4000-8000-00000000000b"; // child of R whose blocks endpoint 500s
const OLD = "10000000-0000-4000-8000-00000000000c"; // trashed, child of R
const OTHER = "10000000-0000-4000-8000-00000000000d"; // a root the selection doesn't pick
const TEAMROOT = "10000000-0000-4000-8000-00000000000e"; // Team Notes, imported into a team space
const IMG = "10000000-0000-4000-8000-000000000008"; // an image block in R
const MAYA_NOTION = "20000000-0000-4000-8000-000000000001";
const IMG_URL = "https://files.example.test/pic.png";
const IMG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
// Sibling-order fixtures: children created in one order (by created_time), listed by Notion in another.
const ORDER_PARENT = "30000000-0000-4000-8000-000000000001"; // "Order parent", a workspace-level page
const FIRST = "30000000-0000-4000-8000-000000000002"; // oldest child
const SECOND = "30000000-0000-4000-8000-000000000003";
const THIRD = "30000000-0000-4000-8000-000000000004"; // listed first by Notion, inside a toggle
const BLANK = "30000000-0000-4000-8000-000000000005"; // untitled, and not in the parent's block list
const SUB_DB = "30000000-0000-4000-8000-000000000006"; // inline database under ORDER_PARENT
const SUB_DS = "30000000-0000-4000-8000-000000000007";
const ROW_X = "30000000-0000-4000-8000-000000000008";
const ROW_Y = "30000000-0000-4000-8000-000000000009"; // the data source returns this row first
const TOGGLE = "30000000-0000-4000-8000-00000000000a";

const orgId = "test-notion-api-org";
const creatorId = "test-notion-api-creator";
const outsiderId = "test-notion-api-outsider";
const mayaId = "test-notion-api-maya";
const teamId = "test-notion-api-team";
const userIds = [creatorId, outsiderId, mayaId];
const ctx: AuthContext = { userId: creatorId, organizationId: orgId };
const outsiderCtx: AuthContext = { userId: outsiderId, organizationId: orgId };
const TOKEN = "ntn_test_token";

function t(content: string, annotations: Record<string, boolean> = {}) {
  return { type: "text", plain_text: content, href: null, annotations: { ...annotations }, text: { content, link: null } };
}

function titleProp(text: string) {
  return { type: "title", title: [t(text)] };
}

function pageObj(pageId: string, title: string, parent: unknown, extra: Record<string, unknown> = {}): NotionSearchResult {
  return { object: "page", id: pageId, parent, properties: { Name: titleProp(title) }, created_time: "2024-01-01T00:00:00.000Z", ...extra } as unknown as NotionSearchResult;
}

function blk(type: string, blockId: string, value: Record<string, unknown>, hasChildren = false): NotionBlock {
  return { object: "block", id: blockId, type, has_children: hasChildren, [type]: value } as NotionBlock;
}

function notionFixture(): FakeNotionData {
  const root = pageObj(R, "Handbook", { type: "workspace", workspace: true }, { icon: { type: "emoji", emoji: "📘" }, created_time: "2024-01-01T00:00:00.000Z" });
  const onboarding = pageObj(C, "Onboarding", { type: "page_id", page_id: R }, { icon: { type: "emoji", emoji: "🚀" }, created_time: "2024-01-02T00:00:00.000Z" });
  const laptop = pageObj(G, "Laptop setup", { type: "page_id", page_id: C }, { created_time: "2024-01-03T00:00:00.000Z" });
  const nested = pageObj(NESTED, "Under a toggle", { type: "block_id", block_id: TOG }, { created_time: "2024-01-04T00:00:00.000Z" });
  const broken = pageObj(BROKEN, "Broken", { type: "page_id", page_id: R }, { created_time: "2024-01-05T00:00:00.000Z" });
  const old = pageObj(OLD, "Old", { type: "page_id", page_id: R }, { in_trash: true });
  const other = pageObj(OTHER, "Unrelated", { type: "workspace", workspace: true });
  const teamRoot = pageObj(TEAMROOT, "Team Notes", { type: "workspace", workspace: true }, { created_time: "2024-01-06T00:00:00.000Z" });
  const database = {
    object: "database",
    id: DB,
    title: [t("Projects")],
    parent: { type: "page_id", page_id: R },
    data_sources: [{ id: DS, name: "Projects" }],
    created_time: "2024-01-03T12:00:00.000Z",
  } as unknown as NotionSearchResult;
  const dataSource = {
    object: "data_source",
    id: DS,
    title: [t("Projects")],
    parent: { type: "database_id", database_id: DB },
    database_parent: { type: "page_id", page_id: R },
    properties: { Name: { type: "title" }, Status: { type: "select" }, Owner: { type: "people" } },
  } as unknown as NotionSearchResult;
  const row1 = {
    object: "page",
    id: ROW1,
    parent: { type: "data_source_id", data_source_id: DS, database_id: DB },
    properties: {
      Name: titleProp("Alpha"),
      Status: { type: "select", select: { name: "Done" } },
      Owner: { type: "people", people: [{ id: MAYA_NOTION, name: "Maya N." }] },
    },
    created_time: "2024-01-03T13:00:00.000Z",
  } as unknown as NotionPage;
  const row2 = {
    object: "page",
    id: ROW2,
    parent: { type: "data_source_id", data_source_id: DS, database_id: DB },
    properties: { Name: titleProp("Beta"), Status: { type: "select", select: { name: "Doing" } }, Owner: { type: "people", people: [] } },
    created_time: "2024-01-03T14:00:00.000Z",
  } as unknown as NotionPage;
  const users: NotionUser[] = [
    { object: "user", id: MAYA_NOTION, type: "person", name: "Maya N.", person: { email: "Maya.Kompast@example.test" } },
    { object: "user", id: "20000000-0000-4000-8000-0000000000bb", type: "bot", name: "Integration" },
  ];
  return {
    workspaceName: "Acme HQ",
    users,
    search: [root, onboarding, laptop, database, dataSource, row1, row2, nested, broken, old, other, teamRoot],
    pages: { [ROW1]: row1, [ROW2]: row2 },
    rows: { [DS]: [row1, row2] },
    databases: { [DB]: database as unknown as NotionDatabase },
    blocks: { [TOG]: blk("toggle", TOG, { rich_text: [] }, true) && ({ object: "block", id: TOG, type: "toggle", parent: { type: "page_id", page_id: R } } as NotionBlock) },
    children: {
      [R]: [
        blk("heading_2", "10000000-0000-4000-8000-000000000010", { rich_text: [t("Start here")], is_toggleable: false }),
        blk("image", IMG, { type: "file", file: { url: IMG_URL }, caption: [] }),
        blk("toggle", TOG, { rich_text: [t("Toggle section")] }, true),
        blk("child_page", C, { title: "Onboarding" }, true),
        blk("child_page", BROKEN, { title: "Broken" }, true),
        blk("child_database", DB, { title: "Projects" }, true),
      ],
      [TOG]: [blk("paragraph", "10000000-0000-4000-8000-0000000000f1", { rich_text: [t("Inside the toggle")] }), blk("child_page", NESTED, { title: "Under a toggle" }, true)],
      [C]: [blk("paragraph", "10000000-0000-4000-8000-0000000000f2", { rich_text: [t("Welcome aboard", { bold: true })] })],
      [G]: [
        blk(
          "paragraph",
          "10000000-0000-4000-8000-0000000000f3",
          {
            rich_text: [
              { type: "mention", plain_text: "Onboarding", mention: { type: "page", page: { id: C } }, annotations: {} },
              t(" for "),
              { type: "mention", plain_text: "@Maya N.", mention: { type: "user", user: { id: MAYA_NOTION, name: "Maya N." } }, annotations: {} },
            ],
          },
        ),
      ],
      [ROW1]: [blk("paragraph", "10000000-0000-4000-8000-0000000000f4", { rich_text: [t("Alpha notes")] })],
      [NESTED]: [blk("paragraph", "10000000-0000-4000-8000-0000000000f5", { rich_text: [t("Nested body")] })],
      [TEAMROOT]: [blk("paragraph", "10000000-0000-4000-8000-0000000000f6", { rich_text: [t("Team text")] })],
    },
    files: { [IMG_URL]: IMG_BYTES },
  };
}

const SELECTION = (teamOf: string) => ({
  roots: [
    { notionId: R, title: "Handbook", target: "workspace" },
    { notionId: TEAMROOT, title: "Team Notes", target: { team: teamOf } },
  ],
});

describe("Notion API migration runner (real Postgres, fake Notion)", () => {
  let captured: unknown[][] = [];
  let assets: { pageId: string; name: string; bytes: number }[] = [];

  async function cleanup() {
    await admin.delete(schema.notionMigration).where(eq(schema.notionMigration.organizationId, orgId));
    await admin.delete(schema.externalRef).where(eq(schema.externalRef.organizationId, orgId));
    await admin.delete(schema.importRun).where(eq(schema.importRun.organizationId, orgId));
    await admin.delete(schema.link).where(eq(schema.link.organizationId, orgId));
    await admin.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(inArray(schema.user.id, userIds));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    captured = [];
    assets = [];
    await admin.insert(schema.organization).values({ id: orgId, name: "Notion API Test Org", slug: orgId });
    await admin.insert(schema.user).values([
      { id: creatorId, name: "Connector", email: "notion-api-creator@example.test" },
      { id: outsiderId, name: "Outsider", email: "notion-api-outsider@example.test" },
      { id: mayaId, name: "Maya Kompast", email: "maya.kompast@example.test" },
    ]);
    await admin.insert(schema.member).values([
      // Importing into the Workspace space needs a workspace admin (requirePageImportTarget).
      { id: id("mem"), organizationId: orgId, userId: creatorId, role: "admin" },
      { id: id("mem"), organizationId: orgId, userId: outsiderId, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: mayaId, role: "member" },
    ]);
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Notion API Team" });
    // The creator is on the team; the outsider isn't.
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${creatorId}`, teamId, userId: creatorId, membershipKey: `${teamId}:${creatorId}` });
  });

  afterAll(cleanup);

  function deps(fake: ReturnType<typeof fakeNotion>, overrides: Partial<NotionMigrationRunnerDeps> = {}): NotionMigrationRunnerDeps {
    return {
      adminDb: admin,
      withTenantAs: withAuthorizedTenant,
      fetch: fake.fetch,
      sleep: async () => {},
      tickBudgetMs: 60_000,
      blocksToYDocState: (blocks) => {
        captured.push(blocks);
        return blocksToYDocState(blocks);
      },
      putPageAsset: async (pageId, name, data) => {
        assets.push({ pageId, name, bytes: data.byteLength });
        return `/api/page-assets/${pageId}/${encodeURIComponent(name)}`;
      },
      ...overrides,
    };
  }

  async function connect(token = TOKEN): Promise<string> {
    const { migrationId } = await withAuthorizedTenant(ctx, (tx) => createNotionMigration(tx, ctx, { token, workspaceName: "" }));
    return migrationId;
  }

  async function current(migrationId: string, c: AuthContext = ctx): Promise<NotionMigrationPublic> {
    const row = await withAuthorizedTenant(c, (tx) => getNotionMigration(tx, migrationId));
    if (!row) throw new Error("migration not visible");
    return row;
  }

  /** Ticks until `done` is true for the migration. Returns how many ticks it took. */
  async function tickUntil(migrationId: string, d: NotionMigrationRunnerDeps, done: (m: NotionMigrationPublic) => boolean, max = 300): Promise<number> {
    for (let i = 0; i < max; i++) {
      const m = await current(migrationId);
      if (done(m)) return i;
      await runNotionMigrationTick(d, m);
    }
    throw new Error("the migration did not reach the expected state");
  }

  /** Discovery, then pick the selection and start the run, then tick it to the end. */
  async function runMigration(migrationId: string, d: NotionMigrationRunnerDeps, selection = SELECTION(teamId)) {
    await tickUntil(migrationId, d, (m) => m.state === "ready");
    await withAuthorizedTenant(ctx, (tx) => saveNotionSelection(tx, ctx, migrationId, selection));
    const { importRunId } = await withAuthorizedTenant(ctx, (tx) => startNotionMigrationRun(tx, ctx, migrationId));
    const ticks = await tickUntil(migrationId, d, (m) => m.state === "done" || m.state === "failed");
    return { importRunId, ticks };
  }

  async function pagesByTitle() {
    const rows = await admin.select().from(schema.page).where(eq(schema.page.organizationId, orgId));
    return new Map(rows.map((r) => [r.title, r]));
  }

  it("discovery scans the workspace and leaves the migration ready to pick pages", async () => {
    const fake = fakeNotion(notionFixture(), { token: TOKEN });
    const migrationId = await connect();
    await tickUntil(migrationId, deps(fake), (m) => m.state === "ready");
    const m = await current(migrationId);
    expect(m.workspaceName).toBe("Acme HQ");
    expect(m.leaseExpiresAt).toBeNull();
    const nodes = (m.discovery as unknown as { nodes: { id: string; kind: string; rowCount?: number; parentId: string | null }[] }).nodes;
    expect(nodes.find((n) => n.id === R)).toMatchObject({ kind: "page", parentId: null });
    expect(nodes.find((n) => n.id === NESTED)?.parentId).toBe(R);
    expect(nodes.find((n) => n.id === DB)).toMatchObject({ kind: "database", rowCount: 2, parentId: R });
    expect(nodes.some((n) => n.kind === "row")).toBe(false);
    expect(nodes.some((n) => n.id === OLD)).toBe(false);
  });

  it("imports the selected pages with their hierarchy, content, files, mentions and people, and records the run", async () => {
    const fake = fakeNotion(notionFixture(), { token: TOKEN, failures: { [`GET /v1/blocks/${BROKEN}/children`]: { status: 500, remaining: Infinity } } });
    const migrationId = await connect();
    const d = deps(fake);
    const { importRunId } = await runMigration(migrationId, d);

    const m = await current(migrationId);
    expect(m.state).toBe("done");
    expect(m.cursor).toBeNull();
    expect(m.hasToken).toBe(true);

    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
    expect(run).toMatchObject({ status: "completed", source: "notion", projectId: null });
    expect(run!.counts).toMatchObject({ planned: 9, created: 9, skipped: 0, contentDone: 9 });
    const errors = run!.errors as { page: string; error: string }[];
    expect(errors).toEqual([expect.objectContaining({ page: "Broken", error: expect.stringContaining("Content not imported") })]);

    const pages = await pagesByTitle();
    const handbook = pages.get("Handbook")!;
    const onboarding = pages.get("Onboarding")!;
    const laptop = pages.get("Laptop setup")!;
    const projects = pages.get("Projects")!;
    expect(handbook).toMatchObject({ parentPageId: null, teamId: null, privateOwnerId: null });
    expect(handbook.icon).toBe("📘");
    expect(onboarding.parentPageId).toBe(handbook.id);
    expect(laptop.parentPageId).toBe(onboarding.id);
    expect(projects.parentPageId).toBe(handbook.id);
    expect(pages.get("Alpha")!.parentPageId).toBe(projects.id);
    expect(pages.get("Beta")!.parentPageId).toBe(projects.id);
    expect(pages.get("Under a toggle")!.parentPageId).toBe(handbook.id);
    expect(pages.has("Old")).toBe(false);
    expect(pages.has("Unrelated")).toBe(false);

    // The team root lands in the team space.
    expect(pages.get("Team Notes")).toMatchObject({ teamId, parentPageId: null });

    // Every created page points at its Notion id, under the workspace key, or the team key for the team root.
    const refs = await admin.select().from(schema.externalRef).where(eq(schema.externalRef.organizationId, orgId));
    expect(refs.map((r) => r.sourceId)).toContain(`workspace:${R}`);
    expect(refs.map((r) => r.sourceId)).toContain(`team:${teamId}:${TEAMROOT}`);
    expect(refs.filter((r) => r.source === "notion")).toHaveLength(9);

    // Content: the broken page stays empty; the others have a ydoc.
    const ydocPages = (await admin.select().from(schema.ydocState).where(inArray(schema.ydocState.pageId, [...pages.values()].map((p) => p.id)))).map((r) => r.pageId);
    expect(ydocPages).toHaveLength(8);
    expect(ydocPages).not.toContain(pages.get("Broken")!.id);

    // A page mention becomes a link row from the mentioning page to the mentioned one (the backlink).
    const links = await admin.select().from(schema.link).where(and(eq(schema.link.organizationId, orgId), eq(schema.link.kind, "mention")));
    // Plus the sub-pages the Handbook body lists (Onboarding, Broken, Projects, and the one under the toggle), and the database table's mentions of its two rows.
    expect(links).toHaveLength(7);
    expect(links).toContainEqual(expect.objectContaining({ fromType: "page", fromId: laptop.id, toType: "page", toId: onboarding.id }));
    expect(links.filter((l) => l.fromId === handbook.id).map((l) => l.toId).sort()).toEqual(
      [onboarding.id, pages.get("Broken")!.id, projects.id, pages.get("Under a toggle")!.id].sort(),
    );
    expect(links.filter((l) => l.fromId === projects.id).map((l) => l.toId).sort()).toEqual([pages.get("Alpha")!.id, pages.get("Beta")!.id].sort());

    // The user mention is written as the matched Kompast member's name (matched by email, case-insensitively).
    const laptopBlocks = JSON.stringify(captured.find((blocks) => JSON.stringify(blocks).includes("@Maya Kompast")));
    expect(laptopBlocks).toContain(`"pageId":"${onboarding.id}"`);

    // The database is a table: its header, one row per row page, each title a mention to that row's page.
    const dbBlocks = JSON.stringify(captured.find((blocks) => JSON.stringify(blocks).includes(`"pageId":"${pages.get("Alpha")!.id}"`)));
    expect(dbBlocks).toContain("Owner");
    expect(dbBlocks).toContain("Maya Kompast");
    expect(dbBlocks).toContain("Done");

    // The Notion-hosted image is copied once, with the page as its owner, and the block points at the copy.
    expect(assets).toEqual([{ pageId: handbook.id, name: "pic.png", bytes: IMG_BYTES.byteLength }]);
    const handbookBlocks = JSON.stringify(captured.find((blocks) => JSON.stringify(blocks).includes("Start here")));
    expect(handbookBlocks).toContain(`/api/page-assets/${handbook.id}/pic.png`);
    expect(handbookBlocks).toContain("Inside the toggle");
    // The sub-page is a mention at its place in the body; its own content stays on its own page.
    expect(handbookBlocks).toContain(`"pageId":"${pages.get("Under a toggle")!.id}"`);
    expect(handbookBlocks).not.toContain("Nested body");
  });

  it("keeps the team root out of view for a member who isn't on the team", async () => {
    const fake = fakeNotion(notionFixture(), { token: TOKEN });
    const migrationId = await connect();
    await runMigration(migrationId, deps(fake));
    const teamPage = (await pagesByTitle()).get("Team Notes")!;
    const seenByCreator = await withAuthorizedTenant(ctx, (tx) => tx.select({ id: schema.page.id }).from(schema.page).where(eq(schema.page.id, teamPage.id)));
    const seenByOutsider = await withAuthorizedTenant(outsiderCtx, (tx) => tx.select({ id: schema.page.id }).from(schema.page).where(eq(schema.page.id, teamPage.id)));
    expect(seenByCreator).toHaveLength(1);
    expect(seenByOutsider).toHaveLength(0);
  });

  it("creates nothing when the same selection is imported again into the same spaces", async () => {
    const fake = fakeNotion(notionFixture(), { token: TOKEN });
    const migrationId = await connect();
    const d = deps(fake);
    const first = await runMigration(migrationId, d);
    const before = (await admin.select().from(schema.page).where(eq(schema.page.organizationId, orgId))).length;

    await withAuthorizedTenant(ctx, (tx) => requestNotionDiscovery(tx, ctx, migrationId));
    const second = await runMigration(migrationId, d);
    expect(second.importRunId).not.toBe(first.importRunId);

    const after = await admin.select().from(schema.page).where(eq(schema.page.organizationId, orgId));
    expect(after).toHaveLength(before);
    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, second.importRunId));
    expect(run!.counts).toMatchObject({ created: 0, skipped: 9 });
    expect((await current(migrationId)).state).toBe("done");
  });

  it("resumes across many ticks when each tick only has time for one unit, and ends with the same pages", async () => {
    const fake = fakeNotion(notionFixture(), { token: TOKEN, failures: { [`GET /v1/blocks/${BROKEN}/children`]: { status: 500, remaining: Infinity } } });
    const migrationId = await connect();
    const d = deps(fake, { tickBudgetMs: 0 });
    await tickUntil(migrationId, d, (m) => m.state === "ready");
    await withAuthorizedTenant(ctx, (tx) => saveNotionSelection(tx, ctx, migrationId, SELECTION(teamId)));
    const { importRunId } = await withAuthorizedTenant(ctx, (tx) => startNotionMigrationRun(tx, ctx, migrationId));
    const ticks = await tickUntil(migrationId, d, (m) => m.state === "done" || m.state === "failed");
    // plan, create, users, nine pages of content, finalize: one unit per tick.
    expect(ticks).toBeGreaterThanOrEqual(12);
    expect((await current(migrationId)).state).toBe("done");
    expect([...(await pagesByTitle()).keys()].sort()).toEqual(
      ["Alpha", "Beta", "Broken", "Handbook", "Laptop setup", "Onboarding", "Projects", "Team Notes", "Under a toggle"].sort(),
    );
    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
    expect(run!.counts).toMatchObject({ created: 9, contentDone: 9 });
  });

  it("a tick that lost its lease to a newer tick writes nothing and leaves the newer lease alone", async () => {
    const fake = fakeNotion(notionFixture(), { token: TOKEN });
    const d = deps(fake);
    const migrationId = await connect();
    await tickUntil(migrationId, d, (m) => m.state === "ready");
    await withAuthorizedTenant(ctx, (tx) => saveNotionSelection(tx, ctx, migrationId, SELECTION(teamId)));
    await withAuthorizedTenant(ctx, (tx) => startNotionMigrationRun(tx, ctx, migrationId));

    // Another tick claimed the row after this one's lease expired.
    const future = new Date(Date.now() + 60_000);
    await admin.update(schema.notionMigration).set({ leaseOwner: "fresh-tick", leaseExpiresAt: future }).where(eq(schema.notionMigration.id, migrationId));
    const stale = { ...(await current(migrationId)), leaseOwner: "stale-tick" };
    await runNotionMigrationTick(d, stale);

    const [row] = await admin.select().from(schema.notionMigration).where(eq(schema.notionMigration.id, migrationId));
    expect(row).toMatchObject({ state: "running", cursor: null, error: null, leaseOwner: "fresh-tick" });
    expect(row!.leaseExpiresAt!.getTime()).toBe(future.getTime());
    expect(await admin.select().from(schema.page).where(eq(schema.page.organizationId, orgId))).toHaveLength(0);

    // The tick that holds the lease carries on as usual, and releases it when done.
    await runNotionMigrationTick(d, await current(migrationId));
    const [after] = await admin.select().from(schema.notionMigration).where(eq(schema.notionMigration.id, migrationId));
    expect(after!.leaseOwner).toBeNull();
    expect(after!.state === "done" || after!.cursor !== null).toBe(true);
  });

  it("never overwrites content someone saved in Kompast during the migration", async () => {
    const fake = fakeNotion(notionFixture(), { token: TOKEN });
    const migrationId = await connect();
    const d = deps(fake, { tickBudgetMs: 0 });
    await tickUntil(migrationId, d, (m) => m.state === "ready");
    await withAuthorizedTenant(ctx, (tx) => saveNotionSelection(tx, ctx, migrationId, SELECTION(teamId)));
    const { importRunId } = await withAuthorizedTenant(ctx, (tx) => startNotionMigrationRun(tx, ctx, migrationId));

    // Wait for the content phase, then pretend a user opened Onboarding in Kompast before its turn came.
    await tickUntil(migrationId, d, (m) => (m.cursor as unknown as NotionMigrationCursor | null)?.phase === "content");
    const onboarding = (await pagesByTitle()).get("Onboarding")!;
    const userState = Buffer.from([9, 9, 9]);
    await admin.insert(schema.ydocState).values({ pageId: onboarding.id, state: userState });

    await tickUntil(migrationId, d, (m) => m.state === "done" || m.state === "failed");
    const [ydoc] = await admin.select().from(schema.ydocState).where(eq(schema.ydocState.pageId, onboarding.id));
    expect(Buffer.from(ydoc!.state).equals(userState)).toBe(true);
    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
    expect(run!.errors).toEqual([expect.objectContaining({ page: "Onboarding", error: expect.stringContaining("Edited in Kompast during the migration") })]);
  });

  it("fails the migration when Notion rejects the token, with a message to act on", async () => {
    const fake = fakeNotion(notionFixture(), { token: "ntn_the_real_token" });
    const migrationId = await connect("ntn_a_wrong_token");
    await runNotionMigrationTick(deps(fake), await current(migrationId));
    const m = await current(migrationId);
    expect(m.state).toBe("failed");
    expect(m.error).toMatch(/Notion rejected the token/);
    expect(m.leaseExpiresAt).toBeNull();
    expect(await admin.select().from(schema.page).where(eq(schema.page.organizationId, orgId))).toHaveLength(0);
  });

  // ── sibling order ───────────────────────────────────────────────────────────

  const WORKSPACE = { type: "workspace", workspace: true };
  const iso = (day: string) => `2024-01-${day}T00:00:00.000Z`;

  /** The pages a parent's block list points at, all with one-line titles (no content). */
  function childPage(pageId: string, title: string, createdDay: string): NotionSearchResult {
    return pageObj(pageId, title, { type: "page_id", page_id: ORDER_PARENT }, { created_time: iso(createdDay) });
  }

  async function childTitles(parentPageId: string): Promise<string[]> {
    const rows = await admin.select({ title: schema.page.title }).from(schema.page).where(eq(schema.page.parentPageId, parentPageId)).orderBy(schema.page.rank);
    return rows.map((r) => r.title);
  }

  it("ranks a page's new sub-pages and databases in the order Notion shows them, and puts an untitled child that isn't in its blocks after them", async () => {
    const database = {
      object: "database",
      id: SUB_DB,
      title: [t("Projects")],
      parent: { type: "page_id", page_id: ORDER_PARENT },
      data_sources: [{ id: SUB_DS, name: "Projects" }],
      created_time: iso("06"),
    } as unknown as NotionSearchResult;
    const dataSource = {
      object: "data_source",
      id: SUB_DS,
      title: [t("Projects")],
      parent: { type: "database_id", database_id: SUB_DB },
      database_parent: { type: "page_id", page_id: ORDER_PARENT },
      properties: { Name: { type: "title" } },
    } as unknown as NotionSearchResult;
    const rowX = { object: "page", id: ROW_X, parent: { type: "data_source_id", data_source_id: SUB_DS, database_id: SUB_DB }, properties: { Name: titleProp("Row X") }, created_time: iso("07") } as unknown as NotionPage;
    const rowY = { object: "page", id: ROW_Y, parent: { type: "data_source_id", data_source_id: SUB_DS, database_id: SUB_DB }, properties: { Name: titleProp("Row Y") }, created_time: iso("08") } as unknown as NotionPage;
    const fake = fakeNotion(
      {
        workspaceName: "Acme HQ",
        search: [
          pageObj(ORDER_PARENT, "Order parent", WORKSPACE, { created_time: iso("01") }),
          childPage(FIRST, "First", "02"),
          childPage(SECOND, "Second", "03"),
          childPage(BLANK, "   ", "04"),
          childPage(THIRD, "Third", "05"),
          database,
          dataSource,
          rowX,
          rowY,
        ],
        pages: { [ROW_X]: rowX, [ROW_Y]: rowY },
        rows: { [SUB_DS]: [rowY, rowX] },
        databases: { [SUB_DB]: database as unknown as NotionDatabase },
        children: {
          [ORDER_PARENT]: [
            blk("child_database", SUB_DB, { title: "Projects" }, true),
            blk("toggle", TOGGLE, { rich_text: [t("Section")] }, true),
            blk("child_page", FIRST, { title: "First" }, true),
            blk("child_page", SECOND, { title: "Second" }, true),
          ],
          [TOGGLE]: [blk("child_page", THIRD, { title: "Third" }, true)],
        },
      },
      { token: TOKEN },
    );
    const migrationId = await connect();
    await runMigration(migrationId, deps(fake), { roots: [{ notionId: ORDER_PARENT, title: "Order parent", target: "workspace" }] });

    const pages = await pagesByTitle();
    // Block order (the database, the toggle's Third, First, Second), with the untitled child after them.
    expect(await childTitles(pages.get("Order parent")!.id)).toEqual(["Projects", "Third", "First", "Second", "Untitled"]);
    // A database's rows follow the order its data source returned them in.
    expect(await childTitles(pages.get("Projects")!.id)).toEqual(["Row Y", "Row X"]);
  });

  it("leaves a child the run skipped at its rank, and puts the children the run created after it in Notion's order", async () => {
    const selection = { roots: [{ notionId: ORDER_PARENT, title: "Order parent", target: "workspace" }] };
    const migrationId = await connect();

    // Run 1 creates the parent and First.
    const firstRun = fakeNotion(
      {
        workspaceName: "Acme HQ",
        search: [pageObj(ORDER_PARENT, "Order parent", WORKSPACE, { created_time: iso("01") }), childPage(FIRST, "First", "02")],
        children: { [ORDER_PARENT]: [blk("child_page", FIRST, { title: "First" }, true)] },
      },
      { token: TOKEN },
    );
    await runMigration(migrationId, deps(firstRun), selection);
    const oldParent = (await pagesByTitle()).get("Order parent")!;
    const firstBefore = (await pagesByTitle()).get("First")!;

    // Drop the parent's link to its page, so run 2 creates a new parent and leaves First alone (skipped).
    await admin.delete(schema.externalRef).where(eq(schema.externalRef.entityId, oldParent.id));

    // Run 2 lists Third, First, Second. Second and Third are created; First is skipped.
    const secondRun = fakeNotion(
      {
        workspaceName: "Acme HQ",
        search: [
          pageObj(ORDER_PARENT, "Order parent", WORKSPACE, { created_time: iso("01") }),
          childPage(FIRST, "First", "02"),
          childPage(SECOND, "Second", "03"),
          childPage(THIRD, "Third", "04"),
        ],
        children: {
          [ORDER_PARENT]: [blk("child_page", THIRD, { title: "Third" }, true), blk("child_page", FIRST, { title: "First" }, true), blk("child_page", SECOND, { title: "Second" }, true)],
        },
      },
      { token: TOKEN },
    );
    const d2 = deps(secondRun, { tickBudgetMs: 0 });
    await withAuthorizedTenant(ctx, (tx) => requestNotionDiscovery(tx, ctx, migrationId));
    await tickUntil(migrationId, d2, (m) => m.state === "ready");
    await withAuthorizedTenant(ctx, (tx) => saveNotionSelection(tx, ctx, migrationId, selection));
    const { importRunId } = await withAuthorizedTenant(ctx, (tx) => startNotionMigrationRun(tx, ctx, migrationId));
    await tickUntil(migrationId, d2, (m) => (m.cursor as unknown as NotionMigrationCursor | null)?.phase === "content");

    // First still sits under the old parent. Move it under the new one, as a child that was already there would be.
    const newParent = (await admin.select().from(schema.page).where(eq(schema.page.organizationId, orgId))).find((p) => p.title === "Order parent" && p.id !== oldParent.id)!;
    await admin.update(schema.page).set({ parentPageId: newParent.id }).where(eq(schema.page.id, firstBefore.id));
    await tickUntil(migrationId, d2, (m) => m.state === "done" || m.state === "failed");

    const [firstAfter] = await admin.select().from(schema.page).where(eq(schema.page.id, firstBefore.id));
    expect(firstAfter).toMatchObject({ parentPageId: newParent.id, rank: firstBefore.rank });
    expect(await childTitles(newParent.id)).toEqual(["First", "Third", "Second"]);
    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
    expect(run!.counts).toMatchObject({ created: 3, skipped: 1 });
  });

  // ── plan walk ───────────────────────────────────────────────────────────────

  const SEL = "40000000-0000-4000-8000-000000000001"; // "Selected", the root the run imports
  const OUT = "40000000-0000-4000-8000-000000000002"; // "Not selected", a workspace root outside the selection
  const OUT_CHILD = "40000000-0000-4000-8000-000000000003"; // a sub-page of OUT
  const COL_LIST = "40000000-0000-4000-8000-000000000004"; // a column layout in SEL
  const COL = "40000000-0000-4000-8000-000000000005"; // its column
  const FIELD = "40000000-0000-4000-8000-000000000006"; // "Field note": a sub-page whose parent is the column (a block parent)
  const TASKS = "40000000-0000-4000-8000-000000000007"; // "Tasks", a database in SEL
  const TASKS_DS = "40000000-0000-4000-8000-000000000008";
  const TASK1 = "40000000-0000-4000-8000-000000000009"; // "Task one", a row
  const TASK2 = "40000000-0000-4000-8000-00000000000a"; // "Task two", a row
  const TASK1_SUB = "40000000-0000-4000-8000-00000000000b"; // "Task detail": a sub-page in row one's body

  function planFixture(): FakeNotionData {
    const sel = pageObj(SEL, "Selected", WORKSPACE, { created_time: iso("01") });
    const out = pageObj(OUT, "Not selected", WORKSPACE, { created_time: iso("01") });
    const outChild = pageObj(OUT_CHILD, "Outside child", { type: "page_id", page_id: OUT }, { created_time: iso("02") });
    const field = pageObj(FIELD, "Field note", { type: "block_id", block_id: COL }, { created_time: iso("03") });
    const tasks = {
      object: "database",
      id: TASKS,
      title: [t("Tasks")],
      parent: { type: "page_id", page_id: SEL },
      data_sources: [{ id: TASKS_DS, name: "Tasks" }],
      created_time: iso("02"),
    } as unknown as NotionSearchResult;
    const dataSource = {
      object: "data_source",
      id: TASKS_DS,
      title: [t("Tasks")],
      parent: { type: "database_id", database_id: TASKS },
      database_parent: { type: "page_id", page_id: SEL },
      properties: { Name: { type: "title" } },
    } as unknown as NotionSearchResult;
    const row = (rowId: string, title: string, day: string) =>
      ({ object: "page", id: rowId, parent: { type: "data_source_id", data_source_id: TASKS_DS, database_id: TASKS }, properties: { Name: titleProp(title) }, created_time: iso(day) }) as unknown as NotionPage;
    const task1 = row(TASK1, "Task one", "04");
    const task2 = row(TASK2, "Task two", "05");
    const task1Sub = pageObj(TASK1_SUB, "Task detail", { type: "page_id", page_id: TASK1 }, { created_time: iso("06") });
    return {
      workspaceName: "Acme HQ",
      search: [sel, out, outChild, field, tasks, dataSource, task1, task2, task1Sub],
      pages: { [TASK1]: task1, [TASK2]: task2 },
      rows: { [TASKS_DS]: [task1, task2] },
      databases: { [TASKS]: tasks as unknown as NotionDatabase },
      blocks: {
        [COL]: { object: "block", id: COL, type: "column", has_children: true, parent: { type: "block_id", block_id: COL_LIST } } as NotionBlock,
        [COL_LIST]: { object: "block", id: COL_LIST, type: "column_list", has_children: true, parent: { type: "page_id", page_id: SEL } } as NotionBlock,
      },
      children: {
        [SEL]: [blk("column_list", COL_LIST, {}, true), blk("child_database", TASKS, { title: "Tasks" }, true)],
        [COL_LIST]: [blk("column", COL, {}, true)],
        [COL]: [blk("child_page", FIELD, { title: "Field note" }, true)],
        [OUT]: [blk("child_page", OUT_CHILD, { title: "Outside child" }, true)],
        [TASK1]: [blk("child_page", TASK1_SUB, { title: "Task detail" }, true)],
      },
    };
  }

  it("plans only the selected subtree, in document order, across tiny ticks, and reads no search", async () => {
    const fake = fakeNotion(planFixture(), { token: TOKEN });
    const migrationId = await connect();
    const d = deps(fake, { tickBudgetMs: 0 });
    await tickUntil(migrationId, d, (m) => m.state === "ready");
    fake.calls.splice(0);
    await withAuthorizedTenant(ctx, (tx) => saveNotionSelection(tx, ctx, migrationId, { roots: [{ notionId: SEL, title: "Selected", target: "workspace" }] }));
    const { importRunId } = await withAuthorizedTenant(ctx, (tx) => startNotionMigrationRun(tx, ctx, migrationId));

    // Stop at the first create tick: the plan is the cursor's items then.
    await tickUntil(migrationId, d, (m) => (m.cursor as unknown as NotionMigrationCursor | null)?.phase === "create");
    const planned = ((await current(migrationId)).cursor as unknown as NotionMigrationCursor).items!;
    expect(planned.map((item) => item.title)).toEqual(["Selected", "Field note", "Tasks", "Task one", "Task two", "Task detail"]);
    expect(planned.map((item) => item.parentId)).toEqual([null, SEL, SEL, TASKS, TASKS, TASK1]);
    expect(planned.every((item) => item.target === "workspace")).toBe(true);
    // Nothing outside the selection was read, and the whole workspace isn't searched again.
    expect(fake.calls.some((call) => call.includes(OUT))).toBe(false);
    expect(fake.calls.some((call) => call === "POST /v1/search")).toBe(false);
    // The selected page's body is read; a leaf page (discovery shows no children under it) is not.
    expect(fake.calls).toContain(`GET /v1/blocks/${SEL}/children`);
    expect(fake.calls.some((call) => call.includes(`/blocks/${FIELD}/`))).toBe(false);

    await tickUntil(migrationId, d, (m) => m.state === "done" || m.state === "failed");
    expect((await current(migrationId)).state).toBe("done");
    const pages = await pagesByTitle();
    expect([...pages.keys()].sort()).toEqual(["Field note", "Selected", "Task detail", "Task one", "Task two", "Tasks"].sort());
    expect(pages.get("Field note")!.parentPageId).toBe(pages.get("Selected")!.id);
    expect(pages.get("Tasks")!.parentPageId).toBe(pages.get("Selected")!.id);
    expect(pages.get("Task one")!.parentPageId).toBe(pages.get("Tasks")!.id);
    expect(pages.get("Task detail")!.parentPageId).toBe(pages.get("Task one")!.id);
    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
    expect(run!.counts).toMatchObject({ planned: 6, created: 6 });
  });

  it("gives a root under another selected root the ancestor's target, and plans it once", async () => {
    const fake = fakeNotion(planFixture(), { token: TOKEN });
    const migrationId = await connect();
    await runMigration(migrationId, deps(fake), {
      roots: [
        { notionId: SEL, title: "Selected", target: "workspace" },
        { notionId: FIELD, title: "Field note", target: { team: teamId } },
      ],
    });
    const pages = await pagesByTitle();
    expect(pages.get("Field note")).toMatchObject({ teamId: null, parentPageId: pages.get("Selected")!.id });
    expect(await admin.select({ id: schema.page.id }).from(schema.page).where(eq(schema.page.title, "Field note"))).toHaveLength(1);
  });

  // ── inline databases ────────────────────────────────────────────────────────

  const WEEK = "50000000-0000-4000-8000-000000000001"; // "Weekly reports": a workspace page whose body shows an inline database
  const INLINE = "50000000-0000-4000-8000-000000000002"; // that database: no title in search, and its data source has none either
  const INLINE_DS = "50000000-0000-4000-8000-000000000003";
  const DRAFT = "50000000-0000-4000-8000-000000000004"; // a row, "Draft spec"
  const REVIEW = "50000000-0000-4000-8000-000000000005"; // a row, "Review"
  const WEEK_HEAD = "50000000-0000-4000-8000-0000000000a1";
  const WEEK_AFTER = "50000000-0000-4000-8000-0000000000a2";
  const WORKSPACE_WEEK = { roots: [{ notionId: WEEK, title: "Weekly reports", target: "workspace" }] };

  function inlineRow(rowId: string, title: string, priority: { name: string; color?: string }, status: { name: string; color?: string }, day: string): NotionPage {
    return {
      object: "page",
      id: rowId,
      parent: { type: "data_source_id", data_source_id: INLINE_DS, database_id: INLINE },
      properties: {
        "Main Function": titleProp(title),
        Note: { type: "rich_text", rich_text: [] },
        Priority: { type: "select", select: priority },
        Status: { type: "status", status },
      },
      created_time: iso(day),
    } as unknown as NotionPage;
  }

  /** A week page whose body shows one inline database holding `rows`. The database's block carries the title "New database". */
  function inlineFixture(rows: NotionPage[]): FakeNotionData {
    const week = pageObj(WEEK, "Weekly reports", WORKSPACE, { created_time: iso("01") });
    const database = {
      object: "database",
      id: INLINE,
      title: [],
      is_inline: true,
      parent: { type: "page_id", page_id: WEEK },
      data_sources: [{ id: INLINE_DS, name: "Data source 1" }],
      created_time: iso("02"),
    } as unknown as NotionSearchResult;
    const dataSource = {
      object: "data_source",
      id: INLINE_DS,
      title: [],
      parent: { type: "database_id", database_id: INLINE },
      database_parent: { type: "page_id", page_id: WEEK },
      properties: { "Main Function": { type: "title" }, Note: { type: "rich_text" }, Priority: { type: "select" }, Status: { type: "status" } },
      created_time: iso("02"),
    } as unknown as NotionSearchResult;
    return {
      workspaceName: "Acme HQ",
      search: [week, database, dataSource],
      pages: Object.fromEntries(rows.map((r) => [r.id, r])),
      rows: { [INLINE_DS]: rows },
      databases: { [INLINE]: database as unknown as NotionDatabase },
      children: {
        [WEEK]: [
          blk("heading_2", WEEK_HEAD, { rich_text: [t("Week 1")], is_toggleable: false }),
          blk("child_database", INLINE, { title: "New database" }, true),
          blk("paragraph", WEEK_AFTER, { rich_text: [t("After the table")] }),
        ],
      },
    };
  }

  /** A table cell's inline nodes, whichever shape the decoded state gives them. */
  const cellNodes = (cell: any): any[] => (Array.isArray(cell) ? cell : (cell.content ?? []));
  const cellText = (cell: any): string => cellNodes(cell).map((n: any) => (n.type === "text" ? n.text : n.type === "mention" ? n.props.title : "")).join("");

  it("shows an inline database's table where its block sits, with the row pages as mentions, colored options, and a title from the block", async () => {
    const fake = fakeNotion(
      inlineFixture([
        inlineRow(DRAFT, "Draft spec", { name: "High", color: "red" }, { name: "Done", color: "green" }, "03"),
        inlineRow(REVIEW, "Review", { name: "Low" }, { name: "Doing", color: "blue" }, "04"),
      ]),
      { token: TOKEN },
    );
    const migrationId = await connect();
    const { importRunId } = await runMigration(migrationId, deps(fake), WORKSPACE_WEEK);
    expect((await current(migrationId)).state).toBe("done");
    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
    expect(run!.errors).toEqual([]);

    const pages = await pagesByTitle();
    const week = pages.get("Weekly reports")!;
    const database = pages.get("New database")!;
    expect(database.parentPageId).toBe(week.id);
    expect(pages.get("Draft spec")!.parentPageId).toBe(database.id);
    expect(pages.get("Review")!.parentPageId).toBe(database.id);
    expect(pages.has("Untitled database")).toBe(false);

    const [ydoc] = await admin.select().from(schema.ydocState).where(eq(schema.ydocState.pageId, week.id));
    const blocks = yDocStateToBlocks(ydoc!.state);
    // heading, the database's link paragraph and table (in place of the block), then the paragraph after it.
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "table", "paragraph"]);
    expect(blocks[1].content.find((n: any) => n.type === "mention").props.pageId).toBe(database.id);
    expect(blocks[3].content.map((n: any) => n.text).join("")).toBe("After the table");

    const rows = blocks[2].content.rows.map((r: any) => r.cells);
    expect(rows.map((cells: any[]) => cells.map(cellText))).toEqual([
      ["Main Function", "Note", "Priority", "Status"],
      ["Draft spec", "", "High", "Done"],
      ["Review", "", "Low", "Doing"],
    ]);
    // The first cell of each row is a mention to that row's page.
    expect(cellNodes(rows[1][0])[0]).toMatchObject({ type: "mention", props: { pageId: pages.get("Draft spec")!.id } });
    expect(cellNodes(rows[2][0])[0]).toMatchObject({ type: "mention", props: { pageId: pages.get("Review")!.id } });
    // Colored options carry their color; an uncolored one doesn't.
    expect(cellNodes(rows[1][2])[0].styles).toEqual({ backgroundColor: "red" });
    expect(cellNodes(rows[1][3])[0].styles).toEqual({ backgroundColor: "green" });
    expect(cellNodes(rows[2][2])[0].styles?.backgroundColor).toBeUndefined();
    expect(cellNodes(rows[2][3])[0].styles).toEqual({ backgroundColor: "blue" });

    // Backlinks: the page mentions its database and both rows (in the table).
    const links = await admin
      .select()
      .from(schema.link)
      .where(and(eq(schema.link.organizationId, orgId), eq(schema.link.kind, "mention"), eq(schema.link.fromId, week.id)));
    expect(links.map((l) => l.toId).sort()).toEqual([database.id, pages.get("Draft spec")!.id, pages.get("Review")!.id].sort());
  });

  it("shows only a link, and no table, for an inline database over 500 rows, and still imports its rows", async () => {
    const rows = Array.from({ length: 501 }, (_, i) =>
      inlineRow(`50000000-0000-4000-8000-${(0x100000 + i).toString(16).padStart(12, "0")}`, `Row ${i}`, { name: "Low" }, { name: "Doing" }, "05"),
    );
    const fake = fakeNotion(inlineFixture(rows), { token: TOKEN });
    const migrationId = await connect();
    const { importRunId } = await runMigration(migrationId, deps(fake), WORKSPACE_WEEK);
    expect((await current(migrationId)).state).toBe("done");

    const pages = await pagesByTitle();
    const week = pages.get("Weekly reports")!;
    const [ydoc] = await admin.select().from(schema.ydocState).where(eq(schema.ydocState.pageId, week.id));
    expect(yDocStateToBlocks(ydoc!.state).map((b) => b.type)).toEqual(["heading", "paragraph", "paragraph"]);
    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
    // The week page, its database page, and the 501 row pages.
    expect(run!.counts).toMatchObject({ created: 503, contentDone: 503 });
  }, 120_000);
});
