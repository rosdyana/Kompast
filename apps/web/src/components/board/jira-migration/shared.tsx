import { useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Badge, type BadgeTone } from "@kompast/ui/Badge";
import { SelectMenu, type SelectOption } from "@kompast/ui/SelectMenu";
import { useTranslation } from "@kompast/i18n";
import type { getJiraMigrationFn, previewJiraMigrationFn } from "@/lib/server-fns/jira-migration";

/** What the mapping may point at, as the server returns it. */
export type JiraTargets = NonNullable<Awaited<ReturnType<typeof getJiraMigrationFn>>["targets"]>;
/** The read-only plan (previewJiraMigrationPlan's return). */
export type JiraPreview = Awaited<ReturnType<typeof previewJiraMigrationFn>>;

export type StatusCategory = "todo" | "in_progress" | "done";
export type SprintState = "closed" | "active" | "future";

/** The message a server function's error carries, or the generic fallback. */
export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** JIRA's statusCategory.key onto Kompast's category. Mirrors mapJiraStatusCategory in packages/import (kept here so the client bundle doesn't pull in the importer). */
export function categoryOfJiraKey(key: string): StatusCategory {
  if (key === "new") return "todo";
  if (key === "done") return "done";
  return "in_progress";
}

const CATEGORY_TONE: Record<StatusCategory, BadgeTone> = { todo: "neutral", in_progress: "amber", done: "green" };

export function CategoryChip({ category }: { category: StatusCategory }) {
  const { t } = useTranslation("board");
  return <Badge tone={CATEGORY_TONE[category]}>{t(`jiraMigration.category.${category}`)}</Badge>;
}

/** Bytes as KB, MB, GB or TB with one decimal. */
export function formatBytes(bytes: number): string {
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** A dropdown that opens the shared SelectMenu from a button, for use in table cells and forms. */
export function OptionPicker({
  value,
  options,
  onChange,
  disabled,
  placeholder,
  ariaLabel,
  width = 280,
}: {
  value: string | null;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel: string;
  width?: number;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-[6px] border border-border-2 bg-surface px-2.5 text-left text-[13.5px] text-text transition-colors hover:border-text-3 disabled:opacity-60"
      >
        <span className="min-w-0 truncate">{current?.label ?? placeholder ?? ""}</span>
        <ChevronDown size={14} strokeWidth={2} className="flex-none text-text-3" />
      </button>
      <SelectMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} options={options} value={value} onSelect={onChange} width={width} />
    </>
  );
}

/** A labelled figure for the review and result summaries. */
export function StatCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-[8px] border border-border bg-surface-2 p-3.5">
      <dt className="type-label-overline text-text-3">{label}</dt>
      <dd className="mt-1 text-[14px] text-text">{children}</dd>
    </div>
  );
}

/** Step title and one-line explanation, used at the top of every step body. */
export function StepHeading({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="type-headline">{title}</h3>
      {description && <p className="mt-1 type-small text-text-2">{description}</p>}
    </div>
  );
}
