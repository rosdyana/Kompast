import { NotionApiError, type NotionClient } from "./client";
import type { NotionDataSource, NotionDatabase, NotionPage, NotionParent, NotionPropertyValue, NotionSearchResult } from "./types";
import { displayTitle, emojiOf, normalizeNotionId, richTextPlain, titleOfProperties } from "./util";

/** Search results the importer reads before discovery (and the migration plan) start. */
export const MAX_DISCOVERY_RESULTS = 20_000;
const MAX_BLOCK_DEPTH = 20;

/** Where an object sits, reduced to what the tree needs. */
export type NotionParentRef =
  | { kind: "workspace" }
  | { kind: "page"; id: string }
  | { kind: "block"; id: string }
  /** A database row (a page whose parent is a data source or database). */
  | { kind: "row"; databaseId: string | null; dataSourceId: string | null }
  | { kind: "other" };

/**
 * One search result, reduced to the fields the tree and the plan use.
 * Stored as-is in the migration cursor, so it stays small (no block bodies, no
 * property values; a data source keeps only its schema's names and types).
 */
export interface NotionObjectSummary {
  object: "page" | "database" | "data_source";
  id: string;
  title: string;
  icon: string | null;
  inTrash: boolean;
  createdTime: string;
  parent: NotionParentRef;
  /** data_source only: the database it belongs to. */
  databaseId?: string | null;
  /** data_source only: where its database sits. */
  databaseParent?: NotionParentRef;
  /** data_source only: the schema, as names and types, title property first. */
  properties?: { name: string; type: string }[];
}

export interface NotionNode {
  id: string;
  kind: "page" | "database" | "row";
  title: string;
  icon: string | null;
  /** The nearest ancestor that is itself a node, or null (a top-level node). */
  parentId: string | null;
  createdTime: string;
  /** Databases only: how many rows the search found. */
  rowCount?: number;
  /** Databases only: the data sources whose rows make up the database. */
  dataSourceIds?: string[];
  /** Databases only: the schema of the first data source, names and types, title property first. */
  properties?: { name: string; type: string }[];
}

export interface NotionDiscovery {
  workspaceName: string;
  nodes: NotionNode[];
  /** True when the search hit MAX_DISCOVERY_RESULTS and stopped early. */
  truncated: boolean;
}

function parentRefOf(parent: NotionParent | undefined): NotionParentRef {
  switch (parent?.type) {
    case "workspace":
      return { kind: "workspace" };
    case "page_id": {
      const id = normalizeNotionId(parent.page_id);
      return id ? { kind: "page", id } : { kind: "other" };
    }
    case "block_id": {
      const id = normalizeNotionId(parent.block_id);
      return id ? { kind: "block", id } : { kind: "other" };
    }
    case "data_source_id":
      return {
        kind: "row",
        dataSourceId: normalizeNotionId(parent.data_source_id),
        databaseId: normalizeNotionId(parent.database_id),
      };
    case "database_id":
      return { kind: "row", dataSourceId: null, databaseId: normalizeNotionId(parent.database_id) };
    default:
      return { kind: "other" };
  }
}

function schemaOf(properties: NotionDataSource["properties"]): { name: string; type: string }[] {
  const entries = Object.entries(properties ?? {}).map(([name, prop]) => ({ name, type: prop.type }));
  // Stable sort: the title property first, the rest in schema order.
  return entries.sort((a, b) => Number(b.type === "title") - Number(a.type === "title"));
}

/**
 * Reduces one search result to a NotionObjectSummary. Null for a result that
 * isn't a page, database or data source, or whose id doesn't parse.
 */
export function summarizeNotionObject(raw: NotionSearchResult): NotionObjectSummary | null {
  const id = normalizeNotionId(raw.id);
  if (!id) return null;
  if (raw.object === "page") {
    const page = raw as NotionPage;
    return {
      object: "page",
      id,
      title: titleOfProperties(page.properties as Record<string, NotionPropertyValue>).trim(),
      icon: emojiOf(page.icon),
      inTrash: page.in_trash === true || page.archived === true,
      createdTime: page.created_time ?? "",
      parent: parentRefOf(page.parent),
    };
  }
  if (raw.object === "database") {
    const db = raw as NotionDatabase;
    return {
      object: "database",
      id,
      title: richTextPlain(db.title).trim(),
      icon: emojiOf(db.icon),
      inTrash: db.in_trash === true,
      createdTime: db.created_time ?? "",
      parent: parentRefOf(db.parent),
    };
  }
  if (raw.object === "data_source") {
    const ds = raw as NotionDataSource;
    return {
      object: "data_source",
      id,
      title: richTextPlain(ds.title).trim(),
      icon: emojiOf(ds.icon),
      inTrash: ds.in_trash === true,
      createdTime: ds.created_time ?? "",
      parent: parentRefOf(ds.parent),
      databaseId: normalizeNotionId(ds.parent?.database_id),
      databaseParent: parentRefOf(ds.database_parent),
      properties: schemaOf(ds.properties),
    };
  }
  return null;
}

interface Draft {
  node: NotionNode;
  /** The parent as the object states it, before checking that the parent is a node. */
  candidate: string | null;
}

/**
 * The page and database tree, pure: the search results go in, nodes come out.
 * Block parents are resolved through `resolveBlockParent` (the page holding
 * the block), so the caller decides whether that is a live lookup or a cache.
 *
 * Trashed objects are skipped. Each database (from a database or a data
 * source) becomes one node; its rows are counted into rowCount and, when
 * `includeRows` is set, listed as "row" nodes under it. A page inside a row
 * hangs off the row's database when rows aren't listed.
 */
export async function buildNotionTree(
  objects: NotionObjectSummary[],
  resolveBlockParent: (blockId: string) => Promise<string | null>,
  options: { includeRows: boolean },
): Promise<NotionNode[]> {
  const live = objects.filter((o) => !o.inTrash);

  const dataSourceDatabase = new Map<string, string>();
  for (const o of live) if (o.object === "data_source" && o.databaseId) dataSourceDatabase.set(o.id, o.databaseId);

  // Rows: a page whose parent is a data source (or database) row.
  const rowDatabase = new Map<string, string>();
  for (const o of live) {
    if (o.object !== "page" || o.parent.kind !== "row") continue;
    const dbId = o.parent.databaseId ?? (o.parent.dataSourceId ? (dataSourceDatabase.get(o.parent.dataSourceId) ?? null) : null);
    if (dbId) rowDatabase.set(o.id, dbId);
  }
  const rowCounts = new Map<string, number>();
  for (const dbId of rowDatabase.values()) rowCounts.set(dbId, (rowCounts.get(dbId) ?? 0) + 1);

  // Databases: from database objects, and from data sources (which fill in what's missing).
  const databases = new Map<string, Draft["node"] & { parentRef: NotionParentRef }>();
  for (const o of live) {
    if (o.object !== "database" || databases.has(o.id)) continue;
    databases.set(o.id, {
      id: o.id,
      kind: "database",
      title: o.title,
      icon: o.icon,
      parentId: null,
      createdTime: o.createdTime,
      parentRef: o.parent,
      dataSourceIds: [],
    });
  }
  for (const o of live) {
    if (o.object !== "data_source" || !o.databaseId) continue;
    let db = databases.get(o.databaseId);
    if (!db) {
      db = {
        id: o.databaseId,
        kind: "database",
        title: o.title,
        icon: o.icon,
        parentId: null,
        createdTime: o.createdTime,
        parentRef: o.databaseParent ?? { kind: "other" },
        dataSourceIds: [],
      };
      databases.set(o.databaseId, db);
    }
    if (db.dataSourceIds && !db.dataSourceIds.includes(o.id)) db.dataSourceIds.push(o.id);
    db.properties ??= o.properties;
    if (!db.title) db.title = o.title;
  }

  const drafts: Draft[] = [];
  const pageIdsSeen = new Set<string>();
  const resolveRef = async (ref: NotionParentRef): Promise<string | null> => {
    if (ref.kind === "page") return ref.id;
    if (ref.kind === "block") return resolveBlockParent(ref.id);
    return null;
  };

  for (const o of live) {
    if (o.object !== "page" || pageIdsSeen.has(o.id)) continue;
    pageIdsSeen.add(o.id);
    const dbId = rowDatabase.get(o.id);
    if (dbId) {
      if (options.includeRows) {
        drafts.push({
          node: { id: o.id, kind: "row", title: displayTitle("row", o.title), icon: o.icon, parentId: null, createdTime: o.createdTime },
          candidate: dbId,
        });
      }
      continue;
    }
    if (o.parent.kind === "row") continue; // a row whose database isn't in the search: nothing to attach it to
    drafts.push({
      node: { id: o.id, kind: "page", title: displayTitle("page", o.title), icon: o.icon, parentId: null, createdTime: o.createdTime },
      candidate: await resolveRef(o.parent),
    });
  }
  for (const db of databases.values()) {
    drafts.push({
      node: {
        id: db.id,
        kind: "database",
        title: displayTitle("database", db.title),
        icon: db.icon,
        parentId: null,
        createdTime: db.createdTime,
        rowCount: rowCounts.get(db.id) ?? 0,
        dataSourceIds: db.dataSourceIds,
        ...(db.properties ? { properties: db.properties } : {}),
      },
      candidate: await resolveRef(db.parentRef),
    });
  }

  // A page inside a row page hangs off the row's database when rows aren't listed.
  const rowParentOf = (candidate: string | null): string | null => {
    if (!candidate) return null;
    if (!options.includeRows && rowDatabase.has(candidate)) return rowDatabase.get(candidate) ?? null;
    return candidate;
  };

  const nodeIds = new Set(drafts.map((d) => d.node.id));
  const nodes: NotionNode[] = [];
  for (const d of drafts) {
    let parentId = d.node.kind === "row" ? d.candidate : rowParentOf(d.candidate);
    if (parentId && !nodeIds.has(parentId)) parentId = null;
    // A row whose database isn't a node can't be placed: leave it out.
    if (d.node.kind === "row" && parentId === null) continue;
    nodes.push({ ...d.node, parentId });
  }
  return nodes;
}

/**
 * The page holding a block, found by walking up through block parents.
 * `cache` is shared across the lookups of one scan, so a deep block costs its
 * walk once; every block visited on the way gets the answer too.
 */
export async function containingPageOf(client: NotionClient, blockId: string, cache: Map<string, string | null>): Promise<string | null> {
  const visited: string[] = [];
  let current: string | null = normalizeNotionId(blockId);
  let result: string | null = null;
  for (let depth = 0; current && depth < MAX_BLOCK_DEPTH; depth++) {
    if (cache.has(current)) {
      result = cache.get(current) ?? null;
      break;
    }
    visited.push(current);
    let parent: { type: string; page_id?: string; block_id?: string };
    try {
      parent = (await client.getBlock(current)).parent ?? { type: "other" };
    } catch (err) {
      // A block the integration can't see (its page isn't shared) has no containing page the importer can use.
      if (err instanceof NotionApiError && err.status === 404) break;
      throw err;
    }
    if (parent.type === "page_id") {
      result = normalizeNotionId(parent.page_id);
      break;
    }
    if (parent.type === "block_id") {
      current = normalizeNotionId(parent.block_id);
      continue;
    }
    result = null;
    break;
  }
  for (const id of visited) cache.set(id, result);
  return result;
}

/**
 * Scans everything the integration can reach and builds the page tree.
 * Pages, databases and data sources come from search (which returns every
 * descendant of a shared page), so no per-page request is needed. Calls
 * onProgress after each search page with the count so far.
 */
export async function discoverNotionWorkspace(
  client: NotionClient,
  options: { onProgress?: (scanned: number) => void | Promise<void>; maxResults?: number } = {},
): Promise<NotionDiscovery> {
  const max = options.maxResults ?? MAX_DISCOVERY_RESULTS;
  const me = await client.me();
  const summaries: NotionObjectSummary[] = [];
  let cursor: string | null = null;
  let scanned = 0;
  let truncated = false;
  do {
    const page = await client.search(cursor);
    scanned += page.results.length;
    for (const raw of page.results) {
      const summary = summarizeNotionObject(raw);
      if (summary) summaries.push(summary);
    }
    await options.onProgress?.(scanned);
    if (scanned >= max) {
      truncated = page.has_more;
      break;
    }
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);

  const blockCache = new Map<string, string | null>();
  const nodes = await buildNotionTree(summaries, (blockId) => containingPageOf(client, blockId, blockCache), { includeRows: false });
  return { workspaceName: me.bot?.workspace_name ?? "", nodes, truncated };
}
