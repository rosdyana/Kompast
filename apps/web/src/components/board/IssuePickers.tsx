import { useEffect, useRef, useState } from "react";
import { Lozenge, StatusDot } from "@kompast/ui/Lozenge";
import { Avatar, UnassignedAvatar } from "@kompast/ui/Avatar";
import { PriorityIcon, type PriorityLike } from "@kompast/ui/PriorityIcon";
import { SelectMenu } from "@kompast/ui/SelectMenu";
import { useTranslation } from "@kompast/i18n";
import { cn } from "@/lib/cn";
import type { ProjectMember, WorkflowStatus } from "./project-shared";

/** Stops a click inside a clickable row/card from also opening the issue. */
function stop(e: React.SyntheticEvent) {
  e.stopPropagation();
  e.preventDefault();
}

export function StatusPicker({
  status,
  statuses,
  fallbackLabel,
  fallbackColor,
  onChange,
  disabled,
}: {
  status: WorkflowStatus | undefined;
  statuses: WorkflowStatus[];
  fallbackLabel?: string;
  fallbackColor?: string;
  onChange: (statusId: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("board");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        onClick={(e) => {
          stop(e);
          setOpen(!open);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={t("backlog.changeStatus")}
        title={t("backlog.changeStatus")}
        className="flex max-w-[140px] flex-none rounded-[4px] outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
      >
        <Lozenge color={status?.color ?? fallbackColor} category={status?.category}>
          {status?.name ?? fallbackLabel ?? "—"}
        </Lozenge>
      </button>
      <SelectMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        placement="bottom-end"
        width={220}
        options={statuses.map((s) => ({ value: s.id, label: s.name, icon: <StatusDot color={s.color} /> }))}
        value={status?.id}
        onSelect={onChange}
      />
    </>
  );
}

export function AssigneePicker({
  assigneeId,
  members,
  onChange,
  size = 24,
  disabled,
}: {
  assigneeId: string | null;
  members: ProjectMember[];
  onChange: (assigneeId: string | null) => void;
  size?: number;
  disabled?: boolean;
}) {
  const { t } = useTranslation("board");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const member = assigneeId ? members.find((m) => m.userId === assigneeId) : undefined;
  const label = member?.name ?? (assigneeId ? "…" : t("backlog.unassigned"));
  return (
    <>
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        onClick={(e) => {
          stop(e);
          setOpen(!open);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={label}
        title={label}
        className="grid flex-none place-items-center rounded-full outline-none ring-offset-1 ring-offset-bg hover:ring-2 hover:ring-border-2 focus-visible:ring-2 focus-visible:ring-accent"
      >
        {member ? <Avatar name={member.name} size={size} /> : <UnassignedAvatar size={size} />}
      </button>
      <SelectMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        placement="bottom-end"
        width={260}
        searchThreshold={5}
        options={[
          { value: "", label: t("backlog.unassigned"), icon: <UnassignedAvatar size={20} /> },
          ...members.map((m) => ({ value: m.userId, label: m.name, hint: m.email, icon: <Avatar name={m.name} size={20} /> })),
        ]}
        value={assigneeId ?? ""}
        onSelect={(v) => onChange(v || null)}
      />
    </>
  );
}

export function PriorityPicker({
  priorityKey,
  levels,
  onChange,
  disabled,
}: {
  priorityKey: string;
  levels: PriorityLike[];
  onChange: (key: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const level = levels.find((p) => p.key === priorityKey) ?? { key: priorityKey, name: priorityKey };
  return (
    <>
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        onClick={(e) => {
          stop(e);
          setOpen(!open);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={level.name}
        className="grid h-6 w-6 flex-none place-items-center rounded-[4px] outline-none hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-accent"
      >
        <PriorityIcon priority={level} />
      </button>
      <SelectMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        placement="bottom-end"
        width={200}
        options={levels.map((p) => ({ value: p.key, label: p.name, icon: <PriorityIcon priority={p} /> }))}
        value={priorityKey}
        onSelect={onChange}
      />
    </>
  );
}

/** Story-points pill that turns into a tiny number input on click. */
export function PointsPill({
  value,
  onChange,
  disabled,
  className,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) setDraft(value == null ? "" : String(value));
  }, [value, editing]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function commit() {
    setEditing(false);
    const next = draft.trim() === "" ? null : Number(draft);
    if (next !== null && (Number.isNaN(next) || next < 0)) return;
    if (next !== value) onChange(next);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onClick={stop}
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-6 w-10 flex-none rounded-full border border-accent bg-surface px-1 text-center text-[12px] font-semibold tabular-nums outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        stop(e);
        setEditing(true);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label="Story points"
      title="Story points"
      className={cn(
        "inline-flex h-5 min-w-[24px] flex-none items-center justify-center rounded-full px-1.5 text-[12px] font-semibold tabular-nums outline-none hover:ring-2 hover:ring-border-2 focus-visible:ring-2 focus-visible:ring-accent",
        value == null ? "bg-surface-3 text-text-3" : "bg-surface-4 text-text-2",
        className,
      )}
    >
      {value ?? "–"}
    </button>
  );
}
