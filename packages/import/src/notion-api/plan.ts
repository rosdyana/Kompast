import type { PageImportTarget } from "@kompast/core";
import type { NotionNode } from "./discover";
import { displayTitle } from "./util";

/** The most pages one migration may import. Past this the run fails before creating anything. */
export const MAX_NOTION_API_PAGES = 10_000;

/** Raised when the selection would import more than MAX_NOTION_API_PAGES. Fatal for the run: no retry helps. */
export class NotionPlanLimitError extends Error {
  constructor(count: number) {
    super(`The selected pages come to ${count}, more than the ${MAX_NOTION_API_PAGES} one migration can import. Select fewer top-level pages and run it again.`);
    this.name = "NotionPlanLimitError";
  }
}

export interface PlannedItem {
  id: string;
  kind: NotionNode["kind"];
  /** Null for a selected root. Otherwise the parent's notion id, which is always earlier in the plan. */
  parentId: string | null;
  title: string;
  icon: string | null;
  /** The space the item's root lands in. Descendants inherit it. */
  target: PageImportTarget;
  createdTime: string;
  dataSourceIds?: string[];
  properties?: { name: string; type: string }[];
}

export interface PlanRoot {
  notionId: string;
  target: PageImportTarget;
}

/**
 * The discovery snapshot, indexed for the plan walk. Rows aren't in the
 * snapshot (discovery doesn't list them), so a page inside a row shows up as a
 * child of the row's database.
 */
export interface PlanIndex {
  byId: Map<string, NotionNode>;
  /** Discovered children by parent id (pages and databases), oldest first. */
  children: Map<string, NotionNode[]>;
}

export function indexDiscovery(nodes: NotionNode[]): PlanIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, NotionNode[]>();
  for (const n of nodes) {
    if (!n.parentId || !byId.has(n.parentId)) continue;
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
  return { byId, children };
}

/**
 * Whether a database has discovered pages under it. Those are sub-pages of its
 * rows (a row's own children are pages whose parent is the row), so the walk
 * has to read the rows' bodies to place them. A database with none needs no
 * row reads at all.
 */
export function databaseHasRowSubPages(index: PlanIndex, databaseId: string): boolean {
  return (index.children.get(databaseId) ?? []).some((n) => n.kind === "page");
}

/** A planned item for a discovered node, under the given parent (null for a selected root). */
export function plannedItemOf(node: NotionNode, parentId: string | null, target: PageImportTarget): PlannedItem {
  return {
    id: node.id,
    kind: node.kind,
    parentId,
    title: node.title,
    icon: node.icon,
    target,
    createdTime: node.createdTime,
    ...(node.dataSourceIds ? { dataSourceIds: node.dataSourceIds } : {}),
    ...(node.properties ? { properties: node.properties } : {}),
  };
}

/** A planned item for a Notion object the discovery snapshot doesn't have (the block that names it is the only source). */
export function unindexedItem(id: string, kind: NotionNode["kind"], rawTitle: string, parentId: string, target: PageImportTarget): PlannedItem {
  return {
    id,
    kind,
    parentId,
    title: displayTitle(kind === "database" ? "database" : "page", rawTitle),
    icon: null,
    target,
    createdTime: "",
  };
}

/**
 * The selected roots as planned items, in selection order. A root that isn't
 * in the discovered tree is reported in missingRoots: it was deleted, trashed,
 * or not shared with the integration. A root under another selected root is
 * dropped as a root (the ancestor wins, and its target covers the subtree).
 */
export function planRootItems(index: PlanIndex, roots: PlanRoot[]): { items: PlannedItem[]; missingRoots: string[] } {
  const selected = new Map<string, PlanRoot>();
  const missingRoots: string[] = [];
  for (const root of roots) {
    if (!index.byId.has(root.notionId)) missingRoots.push(root.notionId);
    else if (!selected.has(root.notionId)) selected.set(root.notionId, root);
  }

  const hasSelectedAncestor = (id: string): boolean => {
    let parent = index.byId.get(id)?.parentId ?? null;
    for (let guard = 0; parent && guard <= index.byId.size; guard++) {
      if (selected.has(parent)) return true;
      parent = index.byId.get(parent)?.parentId ?? null;
    }
    return false;
  };

  const items: PlannedItem[] = [];
  for (const root of selected.values()) {
    if (hasSelectedAncestor(root.notionId)) continue;
    items.push(plannedItemOf(index.byId.get(root.notionId)!, null, root.target));
  }
  return { items, missingRoots };
}
