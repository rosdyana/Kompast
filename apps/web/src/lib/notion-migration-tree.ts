/**
 * Page-selection logic for the Notion API wizard, kept pure so it can be
 * tested without React. The wizard shows the discovered tree (pages and
 * databases); the user checks root pages, and everything under a checked
 * root is included. A root's destination (Workspace, Private, or a team) is
 * chosen per root.
 *
 * Structural types only, so this module doesn't pull the importer into the
 * client bundle. They match NotionNode (packages/import) and
 * PageImportTarget (packages/core).
 */

export type NotionTargetChoice = "workspace" | "private" | { team: string };

export interface TreeNodeLike {
  id: string;
  kind: "page" | "database" | "row";
  title: string;
  icon: string | null;
  parentId: string | null;
  rowCount?: number;
}

export interface NotionTree {
  nodes: Map<string, TreeNodeLike>;
  /** Child ids per parent, in discovery order. */
  childrenOf: Map<string, string[]>;
  /** Ids with no parent in the tree (parentId null, or a parent that isn't a node). Discovery order. */
  topLevel: string[];
  /** Every node id, in discovery order. */
  order: string[];
}

/** Root notion id → chosen destination. Only roots are keys; descendants are implied. */
export type RootSelection = Map<string, NotionTargetChoice>;

export function buildNotionTree(nodes: readonly TreeNodeLike[]): NotionTree {
  const byId = new Map<string, TreeNodeLike>();
  for (const node of nodes) byId.set(node.id, node);
  const childrenOf = new Map<string, string[]>();
  const topLevel: string[] = [];
  for (const node of nodes) {
    if (node.parentId !== null && byId.has(node.parentId)) {
      const siblings = childrenOf.get(node.parentId) ?? [];
      siblings.push(node.id);
      childrenOf.set(node.parentId, siblings);
    } else {
      topLevel.push(node.id);
    }
  }
  return { nodes: byId, childrenOf, topLevel, order: nodes.map((n) => n.id) };
}

/** Every node under `id`, depth-first, not including `id`. */
export function descendantIds(tree: NotionTree, id: string): string[] {
  const out: string[] = [];
  const stack = [...(tree.childrenOf.get(id) ?? [])].reverse();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    out.push(current);
    const kids = tree.childrenOf.get(current) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as string);
  }
  return out;
}

/** The ancestors of `id`, nearest first. */
export function ancestorIds(tree: NotionTree, id: string): string[] {
  const out: string[] = [];
  let parent = tree.nodes.get(id)?.parentId ?? null;
  const seen = new Set<string>();
  while (parent !== null && tree.nodes.has(parent) && !seen.has(parent)) {
    seen.add(parent);
    out.push(parent);
    parent = tree.nodes.get(parent)?.parentId ?? null;
  }
  return out;
}

/** True when an ancestor of `id` is a selected root, so `id` is included without being picked itself. */
export function isImplied(tree: NotionTree, id: string, selection: RootSelection): boolean {
  return ancestorIds(tree, id).some((ancestor) => selection.has(ancestor));
}

/**
 * Checks or unchecks a node. Checking a node that sits under a selected root
 * does nothing (it's already included). Checking a node adds it as a root and
 * drops any roots beneath it, since the new root now covers them. Unchecking
 * removes the root. Returns a new map.
 */
export function toggleRoot(tree: NotionTree, selection: RootSelection, id: string, defaultTarget: NotionTargetChoice): RootSelection {
  if (!tree.nodes.has(id)) return selection;
  if (selection.has(id)) {
    const next = new Map(selection);
    next.delete(id);
    return next;
  }
  if (isImplied(tree, id, selection)) return selection;
  const next = new Map(selection);
  for (const below of descendantIds(tree, id)) next.delete(below);
  next.set(id, defaultTarget);
  return next;
}

/** Sets the destination of every selected root. */
export function setAllDestinations(selection: RootSelection, target: NotionTargetChoice): RootSelection {
  const next: RootSelection = new Map();
  for (const id of selection.keys()) next.set(id, target);
  return next;
}

/** Sets the destination of one selected root. Ignored for an id that isn't a selected root. */
export function setRootDestination(selection: RootSelection, id: string, target: NotionTargetChoice): RootSelection {
  if (!selection.has(id)) return selection;
  const next = new Map(selection);
  next.set(id, target);
  return next;
}

/** The ids included by the selection: each selected root and everything under it. */
export function includedIds(tree: NotionTree, selection: RootSelection): Set<string> {
  const out = new Set<string>();
  for (const root of selection.keys()) {
    if (!tree.nodes.has(root)) continue;
    out.add(root);
    for (const id of descendantIds(tree, root)) out.add(id);
  }
  return out;
}

export interface SelectionCounts {
  /** Selected root pages and databases (the rows of a database aren't roots). */
  roots: number;
  /** Included pages, roots and descendants. Databases excluded. */
  pages: number;
  /** Included databases. */
  databases: number;
  /** Rows across the included databases, from discovery's row counts. */
  rows: number;
}

export function countSelection(tree: NotionTree, selection: RootSelection): SelectionCounts {
  const included = includedIds(tree, selection);
  let pages = 0;
  let databases = 0;
  let rows = 0;
  for (const id of included) {
    const node = tree.nodes.get(id);
    if (!node) continue;
    if (node.kind === "page") pages++;
    if (node.kind === "database") {
      databases++;
      rows += node.rowCount ?? 0;
    }
  }
  return { roots: [...selection.keys()].filter((id) => tree.nodes.has(id)).length, pages, databases, rows };
}

/** The roots as the saved selection wants them, in discovery order. */
export function selectionRoots(tree: NotionTree, selection: RootSelection): { notionId: string; title: string; target: NotionTargetChoice }[] {
  const out: { notionId: string; title: string; target: NotionTargetChoice }[] = [];
  for (const id of tree.order) {
    const target = selection.get(id);
    if (target === undefined) continue;
    out.push({ notionId: id, title: tree.nodes.get(id)?.title ?? "", target });
  }
  return out;
}

/**
 * Rebuilds the selection from a saved one (the migration's selection, as the
 * server returns it). Roots that no longer exist in the tree are dropped.
 */
export function selectionFromSaved(tree: NotionTree, saved: readonly { notionId: string; target: NotionTargetChoice }[]): RootSelection {
  const out: RootSelection = new Map();
  for (const root of saved) {
    if (tree.nodes.has(root.notionId)) out.set(root.notionId, root.target);
  }
  return out;
}

/**
 * The ids to show when the search box holds `query`: every node whose title
 * matches (case-insensitive) plus its ancestors, so a match stays reachable.
 * Null when the query is blank (show everything).
 */
export function searchVisible(tree: NotionTree, query: string): Set<string> | null {
  const q = query.trim().toLowerCase();
  if (q === "") return null;
  const visible = new Set<string>();
  for (const node of tree.nodes.values()) {
    if (!node.title.toLowerCase().includes(q)) continue;
    visible.add(node.id);
    for (const ancestor of ancestorIds(tree, node.id)) visible.add(ancestor);
  }
  return visible;
}

export interface VisibleRow {
  id: string;
  depth: number;
  hasChildren: boolean;
}

/**
 * The rows the tree shows, top to bottom. A node's children appear only when
 * it is expanded. While a search is active (`visible` not null), every
 * matching branch is expanded so the matches show.
 */
export function visibleRows(tree: NotionTree, expanded: ReadonlySet<string>, visible: ReadonlySet<string> | null): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (id: string, depth: number) => {
    if (visible && !visible.has(id)) return;
    const kids = (tree.childrenOf.get(id) ?? []).filter((kid) => !visible || visible.has(kid));
    rows.push({ id, depth, hasChildren: kids.length > 0 });
    if (kids.length === 0) return;
    if (visible || expanded.has(id)) for (const kid of kids) walk(kid, depth + 1);
  };
  for (const id of tree.topLevel) walk(id, 0);
  return rows;
}
