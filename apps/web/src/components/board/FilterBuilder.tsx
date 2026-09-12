import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { FilterCondition, FilterField, FilterOperator } from "@kompast/core/table-view-config";
import { useTranslation } from "@kompast/i18n";

export interface FilterBuilderOptions {
  columns: { name: string }[];
  users: { id: string; name: string }[];
  priorityLevels: { key: string; name: string }[];
  issueTypes: { id: string; name: string }[];
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

function newCondition(): FilterCondition {
  return { id: `f${Math.random().toString(36).slice(2, 9)}`, field: "column", operator: "is", value: null };
}

/** Sprint Review's Notion-style filter builder — field/operator/value rows, ANDed together, persisted into the shared saved_view config (see updateTableViewFn). */
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
  const [open, setOpen] = useState(false);

  function update(index: number, patch: Partial<FilterCondition>) {
    onChange(filters.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }
  function remove(index: number) {
    onChange(filters.filter((_, i) => i !== index));
  }

  function valueOptions(field: FilterField): { value: string; label: string }[] {
    if (field === "column") return options.columns.map((c) => ({ value: c.name, label: c.name }));
    if (field === "assignee") return options.users.map((u) => ({ value: u.id, label: u.name }));
    if (field === "priority") return options.priorityLevels.map((p) => ({ value: p.key, label: p.name }));
    if (field === "type") return options.issueTypes.map((tp) => ({ value: tp.id, label: tp.name }));
    return [];
  }

  function renderValueInput(condition: FilterCondition, index: number) {
    if (condition.operator === "isEmpty" || condition.operator === "isNotEmpty") return null;

    if (condition.field === "points") {
      return (
        <input
          type="number"
          value={typeof condition.value === "number" ? condition.value : ""}
          onChange={(e) => update(index, { value: e.target.value === "" ? null : Number(e.target.value) })}
          className="kp-select w-20 rounded-[7px] border border-border bg-surface px-1.5 py-1 text-[12.5px]"
        />
      );
    }
    if (condition.field === "dueDate") {
      return (
        <input
          type="date"
          value={typeof condition.value === "string" ? condition.value : ""}
          onChange={(e) => update(index, { value: e.target.value || null })}
          className="kp-select rounded-[7px] border border-border bg-surface px-1.5 py-1 text-[12.5px]"
        />
      );
    }
    if (condition.field === "title") {
      return (
        <input
          type="text"
          value={typeof condition.value === "string" ? condition.value : ""}
          onChange={(e) => update(index, { value: e.target.value })}
          placeholder={t("tableView.filterValuePlaceholder")}
          className="kp-select rounded-[7px] border border-border bg-surface px-1.5 py-1 text-[12.5px]"
        />
      );
    }

    const opts = valueOptions(condition.field);
    if (condition.operator === "isAnyOf") {
      const selected = Array.isArray(condition.value) ? (condition.value as string[]) : [];
      return (
        <select
          multiple
          value={selected}
          onChange={(e) => update(index, { value: Array.from(e.target.selectedOptions, (o) => o.value) })}
          className="kp-select min-w-[120px] rounded-[7px] border border-border bg-surface px-1.5 py-1 text-[12.5px]"
        >
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    return (
      <select
        value={typeof condition.value === "string" ? condition.value : ""}
        onChange={(e) => update(index, { value: e.target.value })}
        className="kp-select rounded-[7px] border border-border bg-surface px-1.5 py-1 text-[12.5px]"
      >
        <option value="" disabled>
          {t("tableView.filterValuePlaceholder")}
        </option>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="rounded-[7px] border border-border px-2 py-1 text-[12.5px] hover:bg-surface-3">
        {t("tableView.filterLabel")}
        {filters.length > 0 ? ` (${filters.length})` : ""}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 flex min-w-[440px] flex-col gap-2 rounded-xl border border-border bg-surface p-3 shadow-lg">
          {filters.length === 0 && <p className="type-body text-text-3">{t("tableView.noFiltersHint")}</p>}
          {filters.map((condition, index) => (
            <div key={condition.id} className="flex items-center gap-1.5">
              <select
                value={condition.field}
                onChange={(e) => {
                  const field = e.target.value as FilterField;
                  update(index, { field, operator: OPERATORS_BY_FIELD[field][0], value: null });
                }}
                className="kp-select rounded-[7px] border border-border bg-surface px-1.5 py-1 text-[12.5px]"
              >
                {FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {t(`tableView.filterField_${f}`)}
                  </option>
                ))}
              </select>
              <select
                value={condition.operator}
                onChange={(e) => update(index, { operator: e.target.value as FilterOperator, value: null })}
                className="kp-select rounded-[7px] border border-border bg-surface px-1.5 py-1 text-[12.5px]"
              >
                {OPERATORS_BY_FIELD[condition.field].map((op) => (
                  <option key={op} value={op}>
                    {t(`tableView.filterOperator_${op}`)}
                  </option>
                ))}
              </select>
              {renderValueInput(condition, index)}
              <button
                onClick={() => remove(index)}
                title={t("tableView.removeFilterTitle")}
                className="rounded-[7px] p-1 text-text-3 hover:bg-surface-3 hover:text-danger"
              >
                <X size={14} strokeWidth={1.75} />
              </button>
            </div>
          ))}
          <button
            onClick={() => onChange([...filters, newCondition()])}
            className="flex w-fit items-center gap-1 rounded-[7px] border border-border px-2 py-1 text-[12.5px] hover:bg-surface-3"
          >
            <Plus size={13} strokeWidth={1.75} /> {t("tableView.addFilterButton")}
          </button>
        </div>
      )}
    </div>
  );
}
