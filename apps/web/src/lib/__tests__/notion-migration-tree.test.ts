import { describe, expect, it } from "vitest";
import {
  buildNotionTree,
  countSelection,
  descendantIds,
  includedIds,
  isImplied,
  selectionFromSaved,
  selectionRoots,
  searchVisible,
  setAllDestinations,
  setRootDestination,
  toggleRoot,
  visibleRows,
  type NotionTargetChoice,
  type RootSelection,
  type TreeNodeLike,
} from "../notion-migration-tree";

// A small workspace:
//   Home (page)
//     Notes (page)
//       Deep (page)
//     Tasks (database, 3 rows)
//   Archive (page)
//   Orphan (page, parent not in the discovery)
const NODES: TreeNodeLike[] = [
  { id: "home", kind: "page", title: "Home", icon: "🏠", parentId: null },
  { id: "notes", kind: "page", title: "Notes", icon: null, parentId: "home" },
  { id: "deep", kind: "page", title: "Deep dive", icon: null, parentId: "notes" },
  { id: "tasks", kind: "database", title: "Tasks", icon: null, parentId: "home", rowCount: 3 },
  { id: "archive", kind: "page", title: "Archive", icon: null, parentId: null },
  { id: "orphan", kind: "page", title: "Orphan", icon: null, parentId: "missing-parent" },
];

const tree = buildNotionTree(NODES);

describe("buildNotionTree", () => {
  it("puts parentless nodes and nodes whose parent is missing at the top", () => {
    expect(tree.topLevel).toEqual(["home", "archive", "orphan"]);
  });

  it("keeps children in discovery order", () => {
    expect(tree.childrenOf.get("home")).toEqual(["notes", "tasks"]);
    expect(tree.childrenOf.get("notes")).toEqual(["deep"]);
  });
});

describe("descendantIds", () => {
  it("walks depth-first, not including the node itself", () => {
    expect(descendantIds(tree, "home")).toEqual(["notes", "deep", "tasks"]);
    expect(descendantIds(tree, "deep")).toEqual([]);
  });
});

describe("toggleRoot and implied nodes", () => {
  const defaults = "private" as const;

  it("checking a root includes its whole subtree", () => {
    const sel = toggleRoot(tree, new Map(), "home", defaults);
    expect([...sel.keys()]).toEqual(["home"]);
    expect([...includedIds(tree, sel)].sort()).toEqual(["deep", "home", "notes", "tasks"]);
  });

  it("a node under a selected root is implied and can't be picked on its own", () => {
    const sel = toggleRoot(tree, new Map(), "home", defaults);
    expect(isImplied(tree, "deep", sel)).toBe(true);
    expect(toggleRoot(tree, sel, "deep", defaults)).toBe(sel);
  });

  it("checking a parent drops roots already picked beneath it", () => {
    let sel: RootSelection = toggleRoot(tree, new Map(), "deep", defaults);
    expect([...sel.keys()]).toEqual(["deep"]);
    sel = toggleRoot(tree, sel, "home", defaults);
    expect([...sel.keys()]).toEqual(["home"]);
  });

  it("unchecking a root removes it", () => {
    const sel = toggleRoot(tree, toggleRoot(tree, new Map(), "archive", defaults), "archive", defaults);
    expect(sel.size).toBe(0);
  });

  it("ignores ids that aren't in the tree", () => {
    const empty = new Map();
    expect(toggleRoot(tree, empty, "nope", defaults)).toBe(empty);
  });

  it("does not mutate the selection it was given", () => {
    const before: RootSelection = new Map([["archive", "workspace"]]);
    toggleRoot(tree, before, "home", defaults);
    expect([...before.keys()]).toEqual(["archive"]);
  });
});

describe("destinations", () => {
  it("setAllDestinations applies one target to every root", () => {
    const sel: RootSelection = new Map<string, NotionTargetChoice>([
      ["home", "private"],
      ["archive", { team: "t1" }],
    ]);
    const next = setAllDestinations(sel, "workspace");
    expect([...next.values()]).toEqual(["workspace", "workspace"]);
  });

  it("setRootDestination changes one root and ignores unknown ids", () => {
    const sel: RootSelection = new Map([["home", "private"]]);
    expect(setRootDestination(sel, "home", { team: "t9" }).get("home")).toEqual({ team: "t9" });
    expect(setRootDestination(sel, "archive", "workspace")).toBe(sel);
  });
});

describe("countSelection", () => {
  it("counts roots, included pages, databases and rows", () => {
    const sel = toggleRoot(tree, new Map(), "home", "private");
    // Home, Notes and Deep dive are pages; Tasks is the database with 3 rows.
    expect(countSelection(tree, sel)).toEqual({ roots: 1, pages: 3, databases: 1, rows: 3 });
  });

  it("counts a database that is itself a root", () => {
    const sel = toggleRoot(tree, new Map(), "tasks", "private");
    expect(countSelection(tree, sel)).toEqual({ roots: 1, pages: 0, databases: 1, rows: 3 });
  });

  it("is zero for an empty selection", () => {
    expect(countSelection(tree, new Map())).toEqual({ roots: 0, pages: 0, databases: 0, rows: 0 });
  });
});

describe("selectionRoots and selectionFromSaved", () => {
  it("lists roots in discovery order with their titles and targets", () => {
    const sel: RootSelection = new Map<string, "private" | "workspace">([
      ["archive", "workspace"],
      ["home", "private"],
    ]);
    expect(selectionRoots(tree, sel)).toEqual([
      { notionId: "home", title: "Home", target: "private" },
      { notionId: "archive", title: "Archive", target: "workspace" },
    ]);
  });

  it("restores a saved selection and drops roots that are gone from the tree", () => {
    const sel = selectionFromSaved(tree, [
      { notionId: "home", target: { team: "t1" } },
      { notionId: "gone", target: "private" },
    ]);
    expect([...sel.entries()]).toEqual([["home", { team: "t1" }]]);
  });
});

describe("searchVisible and visibleRows", () => {
  it("returns null for a blank query", () => {
    expect(searchVisible(tree, "   ")).toBeNull();
  });

  it("keeps matches and their ancestors, case-insensitively", () => {
    const visible = searchVisible(tree, "DEEP");
    expect(visible && [...visible].sort()).toEqual(["deep", "home", "notes"]);
  });

  it("shows only top-level rows when nothing is expanded", () => {
    expect(visibleRows(tree, new Set(), null).map((r) => r.id)).toEqual(["home", "archive", "orphan"]);
  });

  it("shows the children of expanded nodes, with depth", () => {
    const rows = visibleRows(tree, new Set(["home", "notes"]), null);
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ["home", 0],
      ["notes", 1],
      ["deep", 2],
      ["tasks", 1],
      ["archive", 0],
      ["orphan", 0],
    ]);
    expect(rows.find((r) => r.id === "deep")?.hasChildren).toBe(false);
    expect(rows.find((r) => r.id === "home")?.hasChildren).toBe(true);
  });

  it("expands every matching branch while searching", () => {
    const visible = searchVisible(tree, "deep");
    expect(visibleRows(tree, new Set(), visible).map((r) => r.id)).toEqual(["home", "notes", "deep"]);
  });
});
