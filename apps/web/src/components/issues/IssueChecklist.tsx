import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { IconButton } from "@kompast/ui/Button";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation } from "@kompast/i18n";
import { addChecklistItemFn, deleteChecklistItemFn, listChecklistFn, moveChecklistItemFn, updateChecklistItemFn } from "@/lib/server-fns/checklist";
import { cn } from "@/lib/cn";

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface ChecklistSummary {
  done: number;
  total: number;
}

export function summarize(items: ChecklistItem[]): ChecklistSummary | null {
  return items.length === 0 ? null : { done: items.filter((i) => i.done).length, total: items.length };
}

export function ChecklistProgress({ summary, className }: { summary: ChecklistSummary; className?: string }) {
  const pct = summary.total === 0 ? 0 : Math.round((summary.done / summary.total) * 100);
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-3", className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className={cn("h-full rounded-full transition-[width]", pct === 100 ? "bg-green" : "bg-accent")} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Jira-checklist-plugin-style to-do list for one issue: check off, add,
 * inline-rename, reorder (up/down) and delete. Optimistic — the local list
 * updates immediately and reloads from the server only if a write fails.
 * `initialItems` comes from the issue page loader; the board-card popover
 * omits it and fetches on mount instead. `onChange` reports the new
 * progress so a parent (the card badge) can stay in sync without a full
 * router invalidate.
 */
export function IssueChecklist({
  issueId,
  initialItems,
  onChange,
  compact,
  autoFocusAdd,
}: {
  issueId: string;
  initialItems?: ChecklistItem[];
  onChange?: (summary: ChecklistSummary | null) => void;
  compact?: boolean;
  autoFocusAdd?: boolean;
}) {
  const { t } = useTranslation("issue");
  const toast = useToast();
  const [items, setItems] = useState<ChecklistItem[] | null>(initialItems ?? null);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const addRef = useRef<HTMLInputElement>(null);

  async function reload() {
    try {
      setItems(await listChecklistFn({ data: issueId }));
    } catch {
      setItems((prev) => prev ?? []);
    }
  }

  useEffect(() => {
    if (initialItems) setItems(initialItems);
    else reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId, initialItems]);

  function commit(next: ChecklistItem[]) {
    setItems(next);
    onChange?.(summarize(next));
  }

  async function run(next: ChecklistItem[], write: () => Promise<unknown>) {
    commit(next);
    try {
      await write();
    } catch (err) {
      toast.show({ tone: "error", title: t("checklist.saveFailed"), description: err instanceof Error ? err.message : undefined });
      const fresh = await listChecklistFn({ data: issueId }).catch(() => null);
      if (fresh) commit(fresh);
    }
  }

  async function add() {
    const text = draft.trim();
    if (!text || !items) return;
    setDraft("");
    try {
      const created = await addChecklistItemFn({ data: { issueId, text } });
      commit([...items, created]);
    } catch (err) {
      setDraft(text);
      toast.show({ tone: "error", title: t("checklist.saveFailed"), description: err instanceof Error ? err.message : undefined });
    }
    addRef.current?.focus();
  }

  function toggle(item: ChecklistItem) {
    if (!items) return;
    run(
      items.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)),
      () => updateChecklistItemFn({ data: { itemId: item.id, done: !item.done } }),
    );
  }

  function saveEdit(item: ChecklistItem) {
    const text = editDraft.trim();
    setEditingId(null);
    if (!items || !text || text === item.text) return;
    run(
      items.map((i) => (i.id === item.id ? { ...i, text } : i)),
      () => updateChecklistItemFn({ data: { itemId: item.id, text } }),
    );
  }

  function remove(item: ChecklistItem) {
    if (!items) return;
    run(
      items.filter((i) => i.id !== item.id),
      () => deleteChecklistItemFn({ data: { itemId: item.id } }),
    );
  }

  function move(index: number, direction: "up" | "down") {
    if (!items) return;
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target]!, next[index]!];
    run(next, () => moveChecklistItemFn({ data: { itemId: items[index]!.id, direction } }));
  }

  if (!items) return <p className="type-small text-text-3">{t("checklist.loading")}</p>;

  const summary = summarize(items);

  return (
    <div className="flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      {summary && (
        <div className="mb-1 flex items-center gap-2.5">
          <ChecklistProgress summary={summary} className="flex-1" />
          <span className="flex-none text-[12px] tabular-nums text-text-3">{t("checklist.progress", { done: summary.done, total: summary.total })}</span>
        </div>
      )}

      {items.length > 0 && (
        <ul className={cn("flex flex-col", compact ? "max-h-[260px] overflow-y-auto" : "")}>
          {items.map((item, index) => (
            <li key={item.id} className="group/item flex min-h-8 items-center gap-2 rounded-[5px] px-1.5 hover:bg-surface-2">
              <input
                type="checkbox"
                checked={item.done}
                onChange={() => toggle(item)}
                aria-label={item.text}
                className="h-4 w-4 flex-none cursor-pointer"
              />
              {editingId === item.id ? (
                <input
                  autoFocus
                  value={editDraft}
                  maxLength={500}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onBlur={() => saveEdit(item)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveEdit(item);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  className="kp-input h-7 min-w-0 flex-1 px-1.5 text-[13.5px]"
                />
              ) : (
                <button
                  type="button"
                  title={t("clickToEdit")}
                  onClick={() => {
                    setEditingId(item.id);
                    setEditDraft(item.text);
                  }}
                  className={cn("min-w-0 flex-1 break-words py-1 text-left text-[13.5px] leading-snug", item.done ? "text-text-3 line-through" : "text-text")}
                >
                  {item.text}
                </button>
              )}
              <span className="flex flex-none items-center opacity-0 focus-within:opacity-100 group-hover/item:opacity-100">
                {!compact && (
                  <>
                    <IconButton size="xs" aria-label={t("checklist.moveUp")} title={t("checklist.moveUp")} disabled={index === 0} onClick={() => move(index, "up")}>
                      <ArrowUp size={13} />
                    </IconButton>
                    <IconButton
                      size="xs"
                      aria-label={t("checklist.moveDown")}
                      title={t("checklist.moveDown")}
                      disabled={index === items.length - 1}
                      onClick={() => move(index, "down")}
                    >
                      <ArrowDown size={13} />
                    </IconButton>
                  </>
                )}
                <IconButton size="xs" aria-label={t("checklist.deleteItem")} title={t("checklist.deleteItem")} onClick={() => remove(item)}>
                  <Trash2 size={13} />
                </IconButton>
              </span>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex items-center gap-2 px-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Plus size={15} className="flex-none text-text-3" />
        <input
          ref={addRef}
          autoFocus={autoFocusAdd}
          value={draft}
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("checklist.addPlaceholder")}
          aria-label={t("checklist.addPlaceholder")}
          className="h-8 min-w-0 flex-1 bg-transparent text-[13.5px] text-text outline-none placeholder:text-text-3"
        />
      </form>
    </div>
  );
}
