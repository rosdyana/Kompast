import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronRight, FileText, Plus } from "lucide-react";
import { useTranslation } from "@kompast/i18n";
import { cn } from "@/lib/cn";

export interface DocsTreePage {
  id: string;
  title: string;
  icon: string | null;
  parentPageId: string | null;
}

interface TreeProps {
  byParent: Map<string | null, DocsTreePage[]>;
  expanded: Set<string>;
  toggle: (id: string) => void;
  activeId: string | undefined;
  onAddChild?: (parentId: string) => void;
  dense?: boolean;
}

export function PageIcon({ icon, size = 16, className }: { icon: string | null | undefined; size?: number; className?: string }) {
  if (icon) {
    return (
      <span aria-hidden className={cn("inline-grid flex-none place-items-center leading-none", className)} style={{ width: size, height: size, fontSize: size - 1 }}>
        {icon}
      </span>
    );
  }
  return <FileText aria-hidden size={size - 1} strokeWidth={1.75} className={cn("flex-none text-text-3", className)} />;
}

function TreeNode({ page, depth, ...tree }: TreeProps & { page: DocsTreePage; depth: number }) {
  const { t } = useTranslation("docs");
  const children = tree.byParent.get(page.id) ?? [];
  const isOpen = tree.expanded.has(page.id);
  const isActive = tree.activeId === page.id;

  return (
    <div>
      <div
        className={cn(
          "group/row relative flex h-[30px] items-center rounded-[6px] pr-1 text-[14px] text-text-2 hover:bg-surface-3",
          isActive && "bg-surface-4 font-medium text-text hover:bg-surface-4",
        )}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        <button
          type="button"
          onClick={() => tree.toggle(page.id)}
          aria-label={isOpen ? "Collapse" : "Expand"}
          aria-expanded={isOpen}
          className="relative grid h-[22px] w-[22px] flex-none place-items-center rounded-[4px] text-text-3 hover:bg-surface-4 hover:text-text"
        >
          <span className="transition-opacity group-hover/row:opacity-0">
            <PageIcon icon={page.icon} size={16} />
          </span>
          <ChevronRight
            size={14}
            strokeWidth={2}
            className={cn("absolute opacity-0 transition group-hover/row:opacity-100", isOpen && "rotate-90")}
          />
        </button>
        <Link
          to="/docs/$pageId"
          params={{ pageId: page.id }}
          className="flex h-full min-w-0 flex-1 items-center pl-1.5 outline-none"
        >
          <span className={cn("truncate", !page.title && "text-text-3")}>{page.title || t("untitled")}</span>
        </Link>
        {tree.onAddChild && (
          <button
            type="button"
            onClick={() => tree.onAddChild!(page.id)}
            aria-label={t("docsTree.addChild", { defaultValue: "Add a page inside" })}
            title={t("docsTree.addChild", { defaultValue: "Add a page inside" })}
            className="grid h-[22px] w-[22px] flex-none place-items-center rounded-[4px] text-text-3 opacity-0 hover:bg-surface-4 hover:text-text focus-visible:opacity-100 group-hover/row:opacity-100"
          >
            <Plus size={14} strokeWidth={2} />
          </button>
        )}
      </div>
      {isOpen &&
        (children.length > 0 ? (
          children.map((child) => <TreeNode key={child.id} page={child} depth={depth + 1} {...tree} />)
        ) : (
          <p className="flex h-[28px] items-center text-[13px] text-text-3" style={{ paddingLeft: 4 + (depth + 1) * 14 + 28 }}>
            {t("docsTree.noPagesInside", { defaultValue: "No pages inside" })}
          </p>
        ))}
    </div>
  );
}

/**
 * Notion-style page tree. Every row's icon turns into a disclosure chevron
 * on hover; ancestors of the page being viewed open automatically so the
 * current page is always visible in the tree.
 */
export function DocsTree({
  pages,
  onAddChild,
  emptyText,
}: {
  pages: DocsTreePage[];
  onAddChild?: (parentId: string) => void;
  emptyText?: string;
}) {
  const { t } = useTranslation("docs");
  const params = useParams({ strict: false }) as { pageId?: string };
  const activeId = params.pageId;

  const byParent = useMemo(() => {
    const map = new Map<string | null, DocsTreePage[]>();
    const ids = new Set(pages.map((p) => p.id));
    for (const page of pages) {
      // A child whose parent isn't visible to this viewer surfaces at the root instead of vanishing.
      const key = page.parentPageId && ids.has(page.parentPageId) ? page.parentPageId : null;
      const list = map.get(key) ?? [];
      list.push(page);
      map.set(key, list);
    }
    return map;
  }, [pages]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!activeId) return;
    const parentOf = new Map(pages.map((p) => [p.id, p.parentPageId]));
    const ancestors: string[] = [];
    let cursor = parentOf.get(activeId) ?? null;
    while (cursor && !ancestors.includes(cursor)) {
      ancestors.push(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
    if (ancestors.length === 0) return;
    setExpanded((prev) => {
      if (ancestors.every((a) => prev.has(a))) return prev;
      const next = new Set(prev);
      ancestors.forEach((a) => next.add(a));
      return next;
    });
  }, [activeId, pages]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const roots = byParent.get(null) ?? [];
  if (roots.length === 0) return <p className="px-2 py-1.5 text-[13px] text-text-3">{emptyText ?? t("docsTree.noPagesYet")}</p>;

  return (
    <div className="flex flex-col gap-px">
      {roots.map((page) => (
        <TreeNode
          key={page.id}
          page={page}
          depth={0}
          byParent={byParent}
          expanded={expanded}
          toggle={toggle}
          activeId={activeId}
          onAddChild={onAddChild}
        />
      ))}
    </div>
  );
}
