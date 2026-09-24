import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  CornerDownLeft,
  FileText,
  Home,
  KanbanSquare,
  KeyRound,
  Inbox,
  Moon,
  Plus,
  Search,
  Settings,
  Sparkles,
  SquarePen,
} from "lucide-react";
import { Dialog } from "@kompast/ui/Dialog";
import { Avatar } from "@kompast/ui/Avatar";
import { Kbd } from "@kompast/ui/Kbd";
import { Spinner } from "@kompast/ui/EmptyState";
import { useTheme } from "@kompast/ui/theme";
import { useTranslation } from "@kompast/i18n";
import { searchWorkspaceFn } from "@/lib/server-fns/search";
import { cn } from "@/lib/cn";
import { PageIcon } from "@/components/docs/DocsTree";
import { ProjectIcon } from "./ProjectIcon";
import type { SidebarShellData } from "./AppSidebar";

interface PaletteItem {
  id: string;
  group: string;
  label: ReactNode;
  /** Plain text used for matching. */
  text: string;
  icon: ReactNode;
  hint?: ReactNode;
  run: () => void;
}

type SearchResult = Awaited<ReturnType<typeof searchWorkspaceFn>>;

function matches(text: string, q: string) {
  if (!q) return true;
  const hay = text.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/**
 * ⌘K palette: one box to jump to any project view, page, issue, or person,
 * or to run a workspace action. Projects/pages/actions filter locally from
 * the shell data already loaded; issues and people come from the server
 * search (debounced) once the query has two characters.
 */
export function CommandPalette({
  open,
  onClose,
  shell,
  onCreateIssue,
  onCreatePage,
}: {
  open: boolean;
  onClose: () => void;
  shell: SidebarShellData;
  onCreateIssue: () => void;
  onCreatePage: () => void;
}) {
  const { t } = useTranslation("nav");
  const router = useRouter();
  const { toggleTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setRemote(null);
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setRemote(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const id = ++reqId.current;
    const timer = setTimeout(async () => {
      try {
        const res = await searchWorkspaceFn({ data: q });
        if (id === reqId.current) setRemote(res);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim();
    const actions: PaletteItem[] = [
      {
        id: "a-create",
        group: t("palette.actions"),
        label: t("createIssue"),
        text: `${t("createIssue")} create issue new`,
        icon: <SquarePen size={16} />,
        hint: <Kbd>C</Kbd>,
        run: go(onCreateIssue),
      },
      {
        id: "a-page",
        group: t("palette.actions"),
        label: t("newPage"),
        text: `${t("newPage")} new page doc`,
        icon: <Plus size={16} />,
        run: go(onCreatePage),
      },
      { id: "a-home", group: t("palette.actions"), label: t("palette.goHome"), text: `${t("palette.goHome")} home`, icon: <Home size={16} />, run: go(() => router.navigate({ to: "/" })) },
      { id: "a-ask", group: t("palette.actions"), label: t("palette.goAsk"), text: `${t("palette.goAsk")} ask ai`, icon: <Sparkles size={16} />, run: go(() => router.navigate({ to: "/ask" })) },
      ...(shell.isAdmin
        ? [{ id: "a-settings", group: t("palette.actions"), label: t("palette.goSettings"), text: `${t("palette.goSettings")} settings`, icon: <Settings size={16} />, run: go(() => router.navigate({ to: "/settings" })) }]
        : []),
      { id: "a-tokens", group: t("palette.actions"), label: t("palette.goTokens"), text: `${t("palette.goTokens")} token api`, icon: <KeyRound size={16} />, run: go(() => router.navigate({ to: "/tokens" })) },
      { id: "a-theme", group: t("palette.actions"), label: t("palette.toggleTheme"), text: `${t("palette.toggleTheme")} theme dark light`, icon: <Moon size={16} />, run: go(toggleTheme) },
    ];

    const projects: PaletteItem[] = shell.projects.flatMap((p) => {
      const teamId = p.teamId ?? "none";
      const base = `${p.name} ${p.key}`;
      const open = (tab: "backlog" | "board") => go(() => router.navigate({ to: "/projects/$teamId/$projectKey", params: { teamId, projectKey: p.key }, search: { tab } }));
      return [
        { id: `p-${p.id}-backlog`, group: t("palette.projects"), label: t("palette.openBacklog", { project: p.name }), text: `${base} backlog`, icon: <ProjectIcon projectKey={p.key} size={18} />, hint: <Inbox size={14} className="text-text-3" />, run: open("backlog") },
        { id: `p-${p.id}-board`, group: t("palette.projects"), label: t("palette.openBoard", { project: p.name }), text: `${base} board kanban`, icon: <ProjectIcon projectKey={p.key} size={18} />, hint: <KanbanSquare size={14} className="text-text-3" />, run: open("board") },
      ];
    });

    const pages: PaletteItem[] = shell.pages.map((p) => ({
      id: `pg-${p.id}`,
      group: t("palette.pages"),
      label: p.title || t("palette.untitled"),
      text: p.title || t("palette.untitled"),
      icon: <PageIcon icon={p.icon} size={16} />,
      run: go(() => router.navigate({ to: "/docs/$pageId", params: { pageId: p.id } })),
    }));

    const issues: PaletteItem[] = (remote?.issues ?? []).map((i) => ({
      id: `i-${i.id}`,
      group: t("palette.issues"),
      label: (
        <span className="flex min-w-0 items-center gap-2">
          <span className="type-key flex-none text-text-3">
            {i.projectKey}-{i.keySeq}
          </span>
          <span className="truncate">{i.title}</span>
        </span>
      ),
      text: `${i.projectKey}-${i.keySeq} ${i.title}`,
      icon: <FileText size={16} className="text-accent" />,
      hint: <span className="text-[12px] text-text-3">{i.statusName}</span>,
      run: go(() =>
        router.navigate({
          to: "/issues/$teamId/$projectKey/$issueKeySeq",
          params: { teamId: i.teamId ?? "none", projectKey: i.projectKey, issueKeySeq: String(i.keySeq) },
        }),
      ),
    }));

    const people: PaletteItem[] = (remote?.people ?? []).map((p) => ({
      id: `u-${p.id}`,
      group: t("palette.people"),
      label: p.name,
      text: `${p.name} ${p.email}`,
      icon: <Avatar name={p.name} size={18} />,
      hint: <span className="text-[12px] text-text-3">{p.email}</span>,
      run: go(() => {}),
    }));

    if (!q) return [...actions, ...projects.filter((p) => p.id.endsWith("-board")).slice(0, 5), ...pages.slice(0, 5)];
    return [
      ...issues,
      ...projects.filter((i) => matches(i.text, q)).slice(0, 6),
      ...pages.filter((i) => matches(i.text, q)).slice(0, 8),
      ...actions.filter((i) => matches(i.text, q)),
      ...people,
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, remote, shell, t]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[active]?.run();
    }
  }

  let lastGroup = "";
  return (
    <Dialog open={open} onClose={onClose} size="lg" align="top" bare>
      <div onKeyDown={onKeyDown} className="flex max-h-[min(70vh,560px)] flex-col">
        <div className="flex h-12 flex-none items-center gap-2.5 border-b border-border px-4">
          <Search size={18} strokeWidth={1.75} className="flex-none text-text-3" />
          <input
            data-autofocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.placeholder")}
            className="min-w-0 flex-1 bg-transparent text-[16px] outline-none"
          />
          {loading && <Spinner size={14} />}
        </div>
        <div ref={listRef} role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {items.length === 0 && !loading && (
            <p className="px-3 py-8 text-center text-[14px] text-text-3">{t("palette.noResults", { query: query.trim() })}</p>
          )}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header && <div className="px-2.5 pb-1 pt-2.5 text-[12px] font-medium text-text-3">{header}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  onMouseMove={() => setActive(i)}
                  onClick={item.run}
                  className={cn(
                    "flex h-9 w-full items-center gap-2.5 rounded-[6px] px-2.5 text-left text-[14px] outline-none",
                    i === active ? "bg-surface-3 text-text" : "text-text-2",
                  )}
                >
                  <span className="grid w-5 flex-none place-items-center text-text-2">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="flex-none">{item.hint}</span>}
                  {i === active && <CornerDownLeft size={14} className="flex-none text-text-3" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex flex-none items-center gap-4 border-t border-border bg-surface-2 px-4 py-2 text-[12px] text-text-3">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> {t("palette.hintNavigate")}
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> {t("palette.hintOpen")}
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>esc</Kbd> {t("palette.hintClose")}
          </span>
        </div>
      </div>
    </Dialog>
  );
}
