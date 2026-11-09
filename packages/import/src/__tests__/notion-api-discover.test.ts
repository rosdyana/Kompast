import { describe, expect, it, vi } from "vitest";
import { createNotionClient } from "../notion-api/client";
import { buildNotionTree, containingPageOf, discoverNotionWorkspace, summarizeNotionObject, type NotionObjectSummary } from "../notion-api/discover";
import type { NotionSearchResult } from "../notion-api/types";
import { fakeNotion } from "./notion-api-fake";

const ROOT = "11111111-1111-1111-1111-111111111111";
const CHILD = "22222222-2222-2222-2222-222222222222";
const NESTED = "33333333-3333-3333-3333-333333333333";
const BLOCK = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DB = "44444444-4444-4444-4444-444444444444";
const DS = "55555555-5555-5555-5555-555555555555";
const ROW1 = "66666666-6666-6666-6666-666666666666";
const ROW2 = "77777777-7777-7777-7777-777777777777";
const ROW_TRASHED = "88888888-8888-8888-8888-888888888888";
const OLD = "99999999-9999-9999-9999-999999999999";
const ORPHAN = "0abcdef0-abcd-abcd-abcd-abcdef012345";
const UNDER_ROW = "1bcdef01-bcde-bcde-bcde-bcdef0123456";

function titleProp(text: string) {
  return { type: "title", title: [{ type: "text", plain_text: text, text: { content: text } }] };
}

function page(id: string, title: string, parent: unknown, extra: Record<string, unknown> = {}) {
  return {
    object: "page",
    id,
    parent,
    properties: { Name: titleProp(title) },
    created_time: "2024-01-01T00:00:00.000Z",
    ...extra,
  } as unknown as NotionSearchResult;
}

const raw: NotionSearchResult[] = [
  page(ROOT, "Handbook", { type: "workspace", workspace: true }, { icon: { type: "emoji", emoji: "📘" } }),
  page(CHILD, "Onboarding", { type: "page_id", page_id: ROOT }, { created_time: "2024-01-02T00:00:00.000Z" }),
  page(NESTED, "Under a toggle", { type: "block_id", block_id: BLOCK }),
  page(OLD, "Old", { type: "page_id", page_id: ROOT }, { in_trash: true }),
  page(ORPHAN, "Orphan", { type: "workspace", workspace: true }),
  {
    object: "database",
    id: DB,
    title: [{ type: "text", plain_text: "Projects" }],
    parent: { type: "page_id", page_id: ROOT },
    created_time: "2024-01-03T00:00:00.000Z",
  } as unknown as NotionSearchResult,
  {
    object: "data_source",
    id: DS,
    title: [{ type: "text", plain_text: "Projects" }],
    parent: { type: "database_id", database_id: DB },
    database_parent: { type: "page_id", page_id: ROOT },
    properties: { Status: { type: "select" }, Name: { type: "title" } },
  } as unknown as NotionSearchResult,
  page(ROW1, "Alpha", { type: "data_source_id", data_source_id: DS, database_id: DB }),
  page(ROW2, "Beta", { type: "data_source_id", data_source_id: DS, database_id: DB }),
  page(ROW_TRASHED, "Gone", { type: "data_source_id", data_source_id: DS, database_id: DB }, { in_trash: true }),
  page(UNDER_ROW, "Notes on Alpha", { type: "page_id", page_id: ROW1 }),
];

function summaries(): NotionObjectSummary[] {
  return raw.map(summarizeNotionObject).filter((s): s is NotionObjectSummary => s !== null);
}

const noBlocks = async () => null;

describe("summarizing search results", () => {
  it("reads titles, emoji icons, parents and the data source schema, and flags trashed objects", () => {
    const byId = new Map(summaries().map((s) => [s.id, s]));
    expect(byId.get(ROOT)).toMatchObject({ object: "page", title: "Handbook", icon: "📘", inTrash: false, parent: { kind: "workspace" } });
    expect(byId.get(CHILD)?.parent).toEqual({ kind: "page", id: ROOT });
    expect(byId.get(NESTED)?.parent).toEqual({ kind: "block", id: BLOCK });
    expect(byId.get(OLD)?.inTrash).toBe(true);
    expect(byId.get(ROW1)?.parent).toEqual({ kind: "row", dataSourceId: DS, databaseId: DB });
    // The title property first, the rest in schema order.
    expect(byId.get(DS)).toMatchObject({ object: "data_source", databaseId: DB, properties: [{ name: "Name", type: "title" }, { name: "Status", type: "select" }] });
  });
});

describe("buildNotionTree", () => {
  it("nests pages under their parents, makes top-level pages roots, and skips trashed pages", async () => {
    const nodes = await buildNotionTree(summaries(), noBlocks, { includeRows: false });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get(ROOT)).toMatchObject({ kind: "page", title: "Handbook", icon: "📘", parentId: null });
    expect(byId.get(CHILD)?.parentId).toBe(ROOT);
    expect(byId.get(ORPHAN)?.parentId).toBeNull();
    expect(byId.has(OLD)).toBe(false);
  });

  it("resolves a block parent to the page holding the block", async () => {
    const resolver = vi.fn(async (blockId: string) => (blockId === BLOCK ? ROOT : null));
    const nodes = await buildNotionTree(summaries(), resolver, { includeRows: false });
    expect(resolver).toHaveBeenCalledWith(BLOCK);
    expect(nodes.find((n) => n.id === NESTED)?.parentId).toBe(ROOT);
  });

  it("makes a database one node with its row count, placed under its page, and leaves rows out of the tree", async () => {
    const nodes = await buildNotionTree(summaries(), noBlocks, { includeRows: false });
    const db = nodes.find((n) => n.id === DB);
    expect(db).toMatchObject({ kind: "database", title: "Projects", parentId: ROOT, rowCount: 2, dataSourceIds: [DS] });
    expect(db?.properties).toEqual([{ name: "Name", type: "title" }, { name: "Status", type: "select" }]);
    expect(nodes.some((n) => n.kind === "row")).toBe(false);
    expect(nodes.some((n) => n.id === ROW1)).toBe(false);
  });

  it("turns a data source with no database object into a database node", async () => {
    const onlyDs = summaries().filter((s) => s.object !== "database");
    const nodes = await buildNotionTree(onlyDs, noBlocks, { includeRows: false });
    expect(nodes.find((n) => n.id === DB)).toMatchObject({ kind: "database", title: "Projects", parentId: ROOT, rowCount: 2 });
  });

  it("lists rows as nodes under their database when includeRows is set, and hangs a page inside a row off the database otherwise", async () => {
    const withRows = await buildNotionTree(summaries(), noBlocks, { includeRows: true });
    const row = withRows.find((n) => n.id === ROW1);
    expect(row).toMatchObject({ kind: "row", parentId: DB, title: "Alpha" });
    expect(withRows.find((n) => n.id === UNDER_ROW)?.parentId).toBe(ROW1);
    expect(withRows.some((n) => n.id === ROW_TRASHED)).toBe(false);

    const discovery = await buildNotionTree(summaries(), noBlocks, { includeRows: false });
    expect(discovery.find((n) => n.id === UNDER_ROW)?.parentId).toBe(DB);
  });
});

describe("containingPageOf", () => {
  it("returns null for a block the integration can't read, instead of failing the scan", async () => {
    const fake = fakeNotion({});
    const client = createNotionClient({ token: "t", fetch: fake.fetch, sleep: async () => {}, minIntervalMs: 0 });
    const cache = new Map<string, string | null>();
    expect(await containingPageOf(client, BLOCK, cache)).toBeNull();
    expect(cache.get(BLOCK)).toBeNull();
  });

  it("walks block parents up to the page, and answers a repeat lookup from the cache", async () => {
    const fake = fakeNotion({
      blocks: {
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb": { object: "block", id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", type: "paragraph", parent: { type: "block_id", block_id: BLOCK } } as never,
        [BLOCK]: { object: "block", id: BLOCK, type: "column", parent: { type: "page_id", page_id: ROOT } } as never,
      },
    });
    const client = createNotionClient({ token: "t", fetch: fake.fetch, sleep: async () => {}, minIntervalMs: 0 });
    const cache = new Map<string, string | null>();
    expect(await containingPageOf(client, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", cache)).toBe(ROOT);
    const calls = fake.calls.length;
    expect(await containingPageOf(client, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", cache)).toBe(ROOT);
    expect(fake.calls.length).toBe(calls);
  });
});

describe("discoverNotionWorkspace", () => {
  it("reads the workspace name, scans every search page, and reports progress", async () => {
    const fake = fakeNotion(
      {
        workspaceName: "Acme HQ",
        search: raw as never,
        blocks: { [BLOCK]: { object: "block", id: BLOCK, type: "column", parent: { type: "page_id", page_id: ROOT } } as never },
      },
      { pageSize: 4 },
    );
    const client = createNotionClient({ token: "t", fetch: fake.fetch, sleep: async () => {}, minIntervalMs: 0 });
    const progress: number[] = [];
    const result = await discoverNotionWorkspace(client, { onProgress: (n) => void progress.push(n) });
    expect(result.workspaceName).toBe("Acme HQ");
    expect(result.truncated).toBe(false);
    expect(progress.at(-1)).toBe(raw.length);
    expect(result.nodes.find((n) => n.id === NESTED)?.parentId).toBe(ROOT);
    expect(result.nodes.find((n) => n.id === DB)?.rowCount).toBe(2);
  });

  it("stops at the result cap and says the scan was truncated", async () => {
    const fake = fakeNotion(
      { workspaceName: "Acme", search: raw as never, blocks: { [BLOCK]: { object: "block", id: BLOCK, type: "column", parent: { type: "page_id", page_id: ROOT } } as never } },
      { pageSize: 4 },
    );
    const client = createNotionClient({ token: "t", fetch: fake.fetch, sleep: async () => {}, minIntervalMs: 0 });
    const result = await discoverNotionWorkspace(client, { maxResults: 4 });
    expect(result.truncated).toBe(true);
    expect(fake.calls.filter((c) => c === "POST /v1/search")).toHaveLength(1);
  });
});

describe("titles", () => {
  const PADDED = "c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1";
  const BLANK_PAGE = "c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2";
  const BLANK_DB = "c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3";
  const SPACES_DB = "c4c4c4c4-c4c4-44c4-84c4-c4c4c4c4c4c4";
  const BLANK_ROW = "c5c5c5c5-c5c5-45c5-85c5-c5c5c5c5c5c5";

  const spaced = (text: string) => [{ type: "text", plain_text: text, text: { content: text } }];

  const objects = (): NotionSearchResult[] => [
    page(PADDED, "    36.0810.1810.23   ", { type: "workspace", workspace: true }),
    page(BLANK_PAGE, "   ", { type: "workspace", workspace: true }),
    { object: "database", id: BLANK_DB, title: [], parent: { type: "workspace", workspace: true }, created_time: "2024-01-01T00:00:00.000Z" } as unknown as NotionSearchResult,
    { object: "database", id: SPACES_DB, title: spaced("  \t "), parent: { type: "workspace", workspace: true }, created_time: "2024-01-01T00:00:00.000Z" } as unknown as NotionSearchResult,
    page(BLANK_ROW, "", { type: "data_source_id", data_source_id: "x", database_id: BLANK_DB }),
  ];

  it("trims titles and names an empty one: Untitled for a page or row, Untitled database for a database", async () => {
    const summarized = objects().map(summarizeNotionObject).filter((s): s is NotionObjectSummary => s !== null);
    expect(summarized.find((s) => s.id === PADDED)?.title).toBe("36.0810.1810.23");

    const nodes = await buildNotionTree(summarized, noBlocks, { includeRows: true });
    expect(nodes.find((n) => n.id === PADDED)).toMatchObject({ kind: "page", title: "36.0810.1810.23" });
    expect(nodes.find((n) => n.id === BLANK_PAGE)).toMatchObject({ kind: "page", title: "Untitled" });
    expect(nodes.find((n) => n.id === BLANK_DB)).toMatchObject({ kind: "database", title: "Untitled database" });
    expect(nodes.find((n) => n.id === SPACES_DB)).toMatchObject({ kind: "database", title: "Untitled database" });
    expect(nodes.find((n) => n.id === BLANK_ROW)).toMatchObject({ kind: "row", title: "Untitled", parentId: BLANK_DB });
  });
});

describe("database titles from discovery", () => {
  const TITLED_DB = "d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1";
  const TITLED_DS = "d2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2";
  const BARE_DB = "d3d3d3d3-d3d3-43d3-83d3-d3d3d3d3d3d3";
  const BARE_DS = "d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4";
  const text = (content: string) => [{ type: "text", plain_text: content, text: { content } }];

  it("titles a database from its own title when the data source's title is empty", async () => {
    const objects = [
      { object: "database", id: TITLED_DB, title: text("New database"), parent: { type: "workspace", workspace: true }, created_time: "2024-01-01T00:00:00.000Z", data_sources: [{ id: TITLED_DS }] },
      { object: "data_source", id: TITLED_DS, title: [], parent: { type: "database_id", database_id: TITLED_DB }, database_parent: { type: "workspace", workspace: true }, properties: { Name: { type: "title" } }, created_time: "2024-01-01T00:00:00.000Z" },
    ] as unknown as NotionSearchResult[];
    const summarized = objects.map(summarizeNotionObject).filter((s): s is NotionObjectSummary => s !== null);
    const nodes = await buildNotionTree(summarized, noBlocks, { includeRows: false });
    expect(nodes.find((n) => n.id === TITLED_DB)).toMatchObject({ kind: "database", title: "New database" });
  });

  it("falls back to 'Untitled database' when neither the database nor its data source has a title", async () => {
    const objects = [
      { object: "data_source", id: BARE_DS, title: [], parent: { type: "database_id", database_id: BARE_DB }, database_parent: { type: "workspace", workspace: true }, properties: { Name: { type: "title" } }, created_time: "2024-01-01T00:00:00.000Z" },
    ] as unknown as NotionSearchResult[];
    const summarized = objects.map(summarizeNotionObject).filter((s): s is NotionObjectSummary => s !== null);
    const nodes = await buildNotionTree(summarized, noBlocks, { includeRows: false });
    expect(nodes.find((n) => n.id === BARE_DB)).toMatchObject({ kind: "database", title: "Untitled database" });
  });
});
