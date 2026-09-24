import { useEffect, useRef, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { SelectMenu, type SelectOption } from "@kompast/ui/SelectMenu";
import { useTranslation } from "@kompast/i18n";
import { cn } from "@/lib/cn";

/** One label/value row of the Details panel (Jira's field grid). */
export function DetailRow({ label, children, align = "center" }: { label: ReactNode; children: ReactNode; align?: "center" | "start" }) {
  return (
    <div className={cn("grid grid-cols-[112px_minmax(0,1fr)] gap-2", align === "center" ? "items-center" : "items-start")}>
      <span className={cn("truncate text-[13px] text-text-2", align === "start" && "pt-[7px]")}>{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const quietTrigger =
  "kp-quiet flex min-h-8 w-full min-w-0 items-center gap-2 text-left text-[14px] disabled:cursor-default disabled:hover:bg-transparent";

/** Click-to-edit value that opens a searchable single-select menu. */
export function InlinePicker({
  display,
  options,
  value,
  onSelect,
  disabled,
  ariaLabel,
  width = 260,
}: {
  display: ReactNode;
  options: SelectOption[];
  value: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  width?: number | "anchor";
}) {
  const { t } = useTranslation("issue");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={quietTrigger}
      >
        {display}
      </button>
      <SelectMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        width={width}
        options={options}
        value={value}
        onSelect={(v) => v !== value && onSelect(v)}
        searchPlaceholder={t("searchPlaceholder")}
        emptyText={t("noMatches")}
      />
    </>
  );
}

/** Multi-select variant (custom multiSelect properties). */
export function InlineMultiPicker({
  display,
  options,
  values,
  onChange,
  ariaLabel,
}: {
  display: ReactNode;
  options: SelectOption[];
  values: string[];
  onChange: (values: string[]) => void;
  ariaLabel: string;
}) {
  const { t } = useTranslation("issue");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(values);
  const ref = useRef<HTMLButtonElement>(null);
  const valuesKey = values.join("\u0000");
  // Keyed on content, not identity — callers pass a freshly built array each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setDraft(values), [valuesKey]);
  return (
    <>
      <button ref={ref} type="button" aria-label={ariaLabel} onClick={() => setOpen(!open)} className={cn(quietTrigger, "flex-wrap py-1")}>
        {display}
      </button>
      <SelectMenu
        multiple
        open={open}
        onClose={() => {
          setOpen(false);
          if (draft.join("\u0000") !== values.join("\u0000")) onChange(draft);
        }}
        anchorRef={ref}
        options={options}
        values={draft}
        onToggle={(v) => setDraft((d) => (d.includes(v) ? d.filter((x) => x !== v) : [...d, v]))}
        searchPlaceholder={t("searchPlaceholder")}
        emptyText={t("noMatches")}
      />
    </>
  );
}

/** Quiet text/number input that commits on blur or Enter, reverts on Escape. */
export function InlineInput({
  value,
  onCommit,
  type = "text",
  placeholder,
  ariaLabel,
  className,
}: {
  value: string;
  onCommit: (value: string) => void;
  type?: "text" | "number" | "url";
  placeholder?: string;
  ariaLabel: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  function commit() {
    if (draft.trim() !== value) onCommit(draft.trim());
  }
  return (
    <input
      type={type}
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      step={type === "number" ? "any" : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        }
      }}
      className={cn("kp-quiet h-8 w-full min-w-0 text-[14px] placeholder:text-text-3", className)}
    />
  );
}

/** Quiet native date input — commits immediately on change. */
export function InlineDate({
  value,
  onCommit,
  ariaLabel,
  tone,
}: {
  value: string;
  onCommit: (value: string | null) => void;
  ariaLabel: string;
  tone?: "danger";
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      type="date"
      value={draft}
      aria-label={ariaLabel}
      onChange={(e) => {
        setDraft(e.target.value);
        if (e.target.value !== value) onCommit(e.target.value || null);
      }}
      className={cn("kp-quiet h-8 w-full min-w-0 text-[14px]", !draft && "text-text-3", tone === "danger" && "font-medium text-danger")}
    />
  );
}

/** Label chips with inline add/remove. */
export function LabelsEditor({ labels, onChange }: { labels: string[]; onChange: (labels: string[]) => void }) {
  const { t } = useTranslation("issue");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  function add() {
    const v = draft.trim().replace(/,$/, "");
    if (v && !labels.includes(v)) onChange([...labels, v]);
    setDraft("");
  }

  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1.5 px-2 py-1">
      {labels.map((label) => (
        <span key={label} className="inline-flex h-6 items-center gap-0.5 rounded-[4px] bg-surface-3 pl-2 pr-0.5 text-[12.5px] text-text">
          {label}
          <button
            type="button"
            aria-label={`${label} ×`}
            onClick={() => onChange(labels.filter((l) => l !== label))}
            className="grid h-5 w-5 place-items-center rounded-[3px] text-text-3 hover:bg-surface-4 hover:text-danger"
          >
            <X size={12} />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            add();
            setAdding(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Escape") {
              setDraft("");
              setAdding(false);
            }
          }}
          placeholder={t("addLabelPlaceholder")}
          className="kp-field h-6 min-w-[140px] flex-1 py-0 text-[13px]"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex h-6 items-center gap-1 rounded-[4px] px-1.5 text-[12.5px] text-text-3 hover:bg-surface-3 hover:text-text"
        >
          <Plus size={13} />
          {labels.length === 0 ? t("addLabel") : null}
        </button>
      )}
    </div>
  );
}

export function EmptyValue({ children }: { children: ReactNode }) {
  return <span className="truncate text-text-3">{children}</span>;
}
