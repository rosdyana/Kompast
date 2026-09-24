import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ListFilter, Plus, Trash2, X } from "lucide-react";
import type { FilterCondition, FilterField, FilterOperator } from "@kompast/core/table-view-config";
import { Popover } from "@kompast/ui/Popover";
import { SelectMenu, type SelectOption } from "@kompast/ui/SelectMenu";
import { StatusDot } from "@kompast/ui/Lozenge";
import { Avatar } from "@kompast/ui/Avatar";
import { IssueTypeIcon } from "@kompast/ui/IssueTypeIcon";
import { PriorityIcon } from "@kompast/ui/PriorityIcon";
import { useTranslation } from "@kompast/i18n";
import { cn } from "@/lib/cn";

export interface FilterBuilderOptions {
  columns: { name: string; color?: string }[];
  users: { id: string; name: string }[];
  priorityLevels: { key: string; name: string; color?: string }[];
  issueTypes: { id: string; name: string; color?: string; hierarchyLevel?: number; isSubtask?: boolean }[];
}

const FIELDS: FilterField[] = ["column", "assignee", "priority", "type", "points", "dueDate", "title"];

const OPERATORS_BY_FIELD: Record<FilterField, FilterOperator[]> = {
  column: ["is", "isNot", "isAnyOf"],
  assignee: ["is", "isNot", "isAnyOf", "isEmpty", "isNotEmpty"],
  priority: ["is", "isNot", "isAnyOf"],
  type: ["is", "isNot", "isAnyOf"],
  points: ["is", "gt", "gte", "lt", "lte", "isEmpty", "isNotEmpty"],
  dueDate: ["before", "after", "isEmpty", "isNotEmpty"],
  title: ["contains", "doesNotContain", "isEmpty", "isNotEmpty"],
};

function newCondition(field: FilterField): FilterCondition {
  return { id: `f${Math.random().toString(36).slice(2, 9)}`, field, operator: OPERATORS_BY_FIELD[field][0]!, value: null };
}

function isComplete(c: FilterCondition) {
  if (c.operator === "isEmpty" || c.operator === "isNotEmpty") return true;
  if (Array.isArray(c.value)) return c.value.length > 0;
  return c.value !== null && c.value !== undefined && c.value !== "";
}

/**
 * Notion-database-style filters: one chip per condition ("Status is To Do"),
 * each opening its own small editor; conditions are ANDed and persisted into
 * the shared saved_view config (see updateTableViewFn). Values are
 * committed as you pick them, so the table narrows live.
 */
export function FilterBuilder({
  filters,
  options,
  onChange,
}: {
  filters: FilterCondition[];
  options: FilterBuilderOptions;
  onChange: (filters: FilterCondition[]) => void;
}) {
  const { t } = useTranslation("board");
  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  function valueOptions(field: FilterField): SelectOption[] {
    if (field === "column") return options.columns.map((c) => ({ value: c.name, label: c.name, icon: <StatusDot color={c.color} /> }));
    if (field === "assignee") return options.users.map((u) => ({ value: u.id, label: u.name, icon: <Avatar name={u.name} size={18} /> }));
    if (field === "priority") return options.priorityLevels.map((p) => ({ value: p.key, label: p.name, icon: <PriorityIcon priority={p} /> }));
    if (field === "type") return options.issueTypes.map((tp) => ({ value: tp.id, label: tp.name, icon: <IssueTypeIcon type={tp} size={16} /> }));
    return [];
  }

  function describeValue(c: FilterCondition): string {
    if (c.operator === "isEmpty" || c.operator === "isNotEmpty") return "";
    const opts = valueOptions(c.field);
    const labelOf = (v: unknown) => opts.find((o) => o.value === v)?.label ?? String(v);
    if (Array.isArray(c.value)) return c.value.map(labelOf).join(", ");
    if (c.value === null || c.value === undefined || c.value === "") return "…";
    return opts.length ? labelOf(c.value) : String(c.value);
  }

  function update(id: string, patch: Partial<FilterCondition>) {
    onChange(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }
  function remove(id: string) {
    setEditingId(null);
    onChange(filters.filter((f) => f.id !== id));
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {filters.map((c) => (
        <FilterChip
          key={c.id}
          condition={c}
          open={editingId === c.id}
          onOpenChange={(open) => setEditingId(open ? c.id : null)}
          summary={
            <>
              <span className="font-medium">{t(`tableView.filterField_${c.field}`)}</span>
              <span className="text-accent-text/80">{t(`tableView.filterOperator_${c.operator}`)}</span>
              {describeValue(c) && <span className="max-w-[160px] truncate font-medium">{describeValue(c)}</span>}
            </>
          }
          complete={isComplete(c)}
          onRemove={() => remove(c.id)}
        >
          <FilterEditor condition={c} valueOptions={valueOptions(c.field)} onChange={(patch) => update(c.id, patch)} onRemove={() => remove(c.id)} />
        </FilterChip>
      ))}
      <button
        ref={addRef}
        type="button"
        onClick={() => setAddOpen((v) => !v)}
        aria-haspopup="listbox"
        className="inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[13px] text-text-2 hover:bg-surface-3 hover:text-text"
      >
        {filters.length === 0 ? <ListFilter size={14} strokeWidth={1.75} /> : <Plus size={14} strokeWidth={2} />}
        {t("tableView.filterLabel")}
      </button>
      <SelectMenu
        open={addOpen}
        onClose={() => setAddOpen(false)}
        anchorRef={addRef}
        width={200}
        value=""
        options={FIELDS.map((f) => ({ value: f, label: t(`tableView.filterField_${f}`) }))}
        onSelect={(f) => {
          const c = newCondition(f as FilterField);
          onChange([...filters, c]);
          // Open the new chip's editor once it has mounted.
          requestAnimationFrame(() => setEditingId(c.id));
        }}
      />
    </div>
  );
}

function FilterChip({
  condition,
  open,
  onOpenChange,
  summary,
  complete,
  onRemove,
  children,
}: {
  condition: FilterCondition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: ReactNode;
  complete: boolean;
  onRemove: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("board");
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center rounded-[6px] text-[13px]",
        complete ? "bg-accent-soft text-accent-text" : "border border-dashed border-border-2 text-text-2",
      )}
    >
      <button ref={ref} type="button" onClick={() => onOpenChange(!open)} className="flex h-full items-center gap-1 pl-2 pr-1" aria-expanded={open}>
        {summary}
        <ChevronDown size={12} strokeWidth={2} className="opacity-70" />
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t("tableView.removeFilterTitle")}
        title={t("tableView.removeFilterTitle")}
        className="grid h-full w-6 place-items-center rounded-r-[6px] opacity-70 hover:opacity-100"
      >
        <X size={12} strokeWidth={2} />
      </button>
      <Popover open={open} onClose={() => onOpenChange(false)} anchorRef={ref} width={300} ariaLabel={condition.field}>
        {children}
      </Popover>
    </span>
  );
}

function FilterEditor({
  condition,
  valueOptions,
  onChange,
  onRemove,
}: {
  condition: FilterCondition;
  valueOptions: SelectOption[];
  onChange: (patch: Partial<FilterCondition>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("board");
  const noValue = condition.operator === "isEmpty" || condition.operator === "isNotEmpty";
  // Text/number values commit on a short debounce so typing doesn't write a view update per keystroke.
  const [draft, setDraft] = useState(condition.value == null ? "" : String(condition.value));
  useEffect(() => setDraft(condition.value == null ? "" : String(condition.value)), [condition.id, condition.field]);
  useEffect(() => {
    if (condition.field !== "title" && condition.field !== "points") return;
    const next = condition.field === "points" ? (draft === "" ? null : Number(draft)) : draft;
    if (next === condition.value || (next === "" && condition.value == null)) return;
    const timer = setTimeout(() => onChange({ value: next }), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const selected: string[] = Array.isArray(condition.value) ? (condition.value as string[]) : typeof condition.value === "string" ? [condition.value] : [];
  const multi = condition.operator === "isAnyOf";

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[13px] font-medium text-text-2">{t(`tableView.filterField_${condition.field}`)}</span>
        <select
          value={condition.operator}
          onChange={(e) => {
            const op = e.target.value as FilterOperator;
            // Keep the chosen values when switching between is/isNot/isAnyOf; reset otherwise.
            const keep = valueOptions.length > 0 && op !== "isEmpty" && op !== "isNotEmpty";
            const value = keep ? (op === "isAnyOf" ? selected : (selected[0] ?? null)) : null;
            onChange({ operator: op, value });
          }}
          aria-label={t("tableEdit.operator")}
          className="kp-field kp-select h-7 min-w-0 flex-1 text-[13px]"
        >
          {OPERATORS_BY_FIELD[condition.field].map((op) => (
            <option key={op} value={op}>
              {t(`tableView.filterOperator_${op}`)}
            </option>
          ))}
        </select>
        <button type="button" onClick={onRemove} aria-label={t("tableView.removeFilterTitle")} className="grid h-7 w-7 flex-none place-items-center rounded-[5px] text-text-3 hover:bg-danger-soft hover:text-danger">
          <Trash2 size={14} strokeWidth={1.75} />
        </button>
      </div>
      {noValue ? (
        <p className="px-3 py-3 text-[13px] text-text-3">{t("tableEdit.noValueNeeded")}</p>
      ) : valueOptions.length > 0 ? (
        <div className="max-h-[260px] overflow-y-auto p-1" role="listbox" aria-multiselectable={multi}>
          {valueOptions.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => {
                  if (multi) onChange({ value: on ? selected.filter((v) => v !== o.value) : [...selected, o.value] });
                  else onChange({ value: o.value });
                }}
                className="flex h-8 w-full items-center gap-2 rounded-[5px] px-2 text-left text-[13.5px] hover:bg-surface-3"
              >
                {multi && (
                  <span className={cn("grid h-4 w-4 flex-none place-items-center rounded-[4px] border", on ? "border-accent bg-accent text-white" : "border-border-2")}>
                    {on && <Check size={11} strokeWidth={3} />}
                  </span>
                )}
                {o.icon}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {!multi && on && <Check size={14} className="text-accent" />}
              </button>
            );
          })}
        </div>
      ) : condition.field === "dueDate" ? (
        <div className="p-3">
          <input
            type="date"
            autoFocus
            value={typeof condition.value === "string" ? condition.value : ""}
            onChange={(e) => onChange({ value: e.target.value || null })}
            aria-label={t("tableView.filterValuePlaceholder")}
            className="kp-input"
          />
        </div>
      ) : (
        <div className="p-3">
          <input
            type={condition.field === "points" ? "number" : "text"}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("tableEdit.typeValue")}
            aria-label={t("tableView.filterValuePlaceholder")}
            className="kp-input"
          />
        </div>
      )}
    </div>
  );
}
