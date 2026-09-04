import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";

export interface DocsTreePage {
  id: string;
  title: string;
  icon: string | null;
  parentPageId: string | null;
}

function TreeNode({ page, byParent, depth }: { page: DocsTreePage; byParent: Map<string | null, DocsTreePage[]>; depth: number }) {
  const params = useParams({ strict: false });
  const children = byParent.get(page.id) ?? [];
  const isActive = params.pageId === page.id;
  const [expanded, setExpanded] = useState(isActive && children.length > 0);

  return (
    <div>
      <div className="flex items-center" style={{ paddingLeft: depth * 14 }}>
        {children.length > 0 ? (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="grid h-4 w-4 flex-none place-items-center text-[9px] text-text-3 hover:text-text"
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-4 flex-none" />
        )}
        <Link
          to="/docs/$pageId"
          params={{ pageId: page.id }}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] hover:bg-surface-3 [&.active]:bg-surface-3 [&.active]:font-semibold"
        >
          <span className="flex-none">{page.icon || "▤"}</span>
          <span className="min-w-0 flex-1 truncate">{page.title || "Tanpa judul"}</span>
        </Link>
      </div>
      {expanded && children.map((child) => <TreeNode key={child.id} page={child} byParent={byParent} depth={depth + 1} />)}
    </div>
  );
}

export function DocsTree({ pages }: { pages: DocsTreePage[] }) {
  const byParent = new Map<string | null, DocsTreePage[]>();
  for (const page of pages) {
    const list = byParent.get(page.parentPageId) ?? [];
    list.push(page);
    byParent.set(page.parentPageId, list);
  }

  const roots = byParent.get(null) ?? [];
  if (roots.length === 0) return <p className="px-2 py-1.5 text-[12px] text-text-3">Belum ada halaman</p>;

  return (
    <div className="flex flex-col gap-px">
      {roots.map((page) => (
        <TreeNode key={page.id} page={page} byParent={byParent} depth={0} />
      ))}
    </div>
  );
}
