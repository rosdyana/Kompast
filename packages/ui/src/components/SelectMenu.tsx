import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import clsx from "clsx";
import { Check, Search } from "lucide-react";
import { Popover, type PopoverPlacement } from "./Popover";

export interface SelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
  /** Secondary text, right-aligned (an email, a key). */
  hint?: string;
  /** Extra text matched by the search box but not shown. */
  keywords?: string;
}

interface BaseProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  options: SelectOption[];
  placement?: PopoverPlacement;
  width?: number | "anchor";
  /** Shows a filter box once the list is longer than this (default 7). */
  searchThreshold?: number;
  searchPlaceholder?: string;
  emptyText?: string;
  footer?: ReactNode;
}

export interface SingleSelectMenuProps extends BaseProps {
  multiple?: false;
  value: string | null | undefined;
  onSelect: (value: string) => void;
}

export interface MultiSelectMenuProps extends BaseProps {
  multiple: true;
  values: string[];
  onToggle: (value: string) => void;
}

/**
 * Keyboard-first option picker (arrow keys, Enter, type-to-filter) inside a
 * Popover — the one control behind every inline edit: status, assignee,
 * priority, sprint, epic, type. Single-select closes on pick; multi-select
 * stays open and toggles.
 */
export function SelectMenu(props: SingleSelectMenuProps | MultiSelectMenuProps) {
  const {
    open,
    onClose,
    anchorRef,
    options,
    placement,
    width = 240,
    searchThreshold = 7,
    searchPlaceholder = "Search…",
    emptyText = "No matches",
    footer,
  } = props;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchable = options.length > searchThreshold;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => `${o.label} ${o.hint ?? ""} ${o.keywords ?? ""}`.toLowerCase().includes(q));
  }, [options, query]);

  const isSelected = (v: string) => (props.multiple ? props.values.includes(v) : props.value === v);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const idx = options.findIndex((o) => isSelected(o.value));
    setActive(idx >= 0 ? idx : 0);
    const id = requestAnimationFrame(() => (searchable ? inputRef.current?.focus() : listRef.current?.focus()));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(option: SelectOption | undefined) {
    if (!option) return;
    if (props.multiple) props.onToggle(option.value);
    else {
      props.onSelect(option.value);
      onClose();
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(filtered.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(filtered[active]);
    } else if (e.key === "Tab") {
      onClose();
    }
  }

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} placement={placement} width={width} role="listbox">
      <div onKeyDown={onKeyDown} className="flex min-h-0 flex-col">
        {searchable && (
          <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
            <Search size={14} strokeWidth={2} className="flex-none text-text-3" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              placeholder={searchPlaceholder}
              className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none"
            />
          </div>
        )}
        <div ref={listRef} tabIndex={-1} className="max-h-[300px] overflow-y-auto p-1 outline-none">
          {filtered.length === 0 && <p className="px-2 py-2 text-[13px] text-text-3">{emptyText}</p>}
          {filtered.map((o, i) => {
            const selected = isSelected(o.value);
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={selected}
                data-index={i}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o)}
                className={clsx(
                  "flex min-h-8 w-full items-center gap-2 rounded-[5px] px-2 py-1 text-left text-[13.5px] outline-none",
                  i === active && "bg-surface-3",
                )}
              >
                {props.multiple && (
                  <span
                    className={clsx(
                      "grid h-4 w-4 flex-none place-items-center rounded-[4px] border",
                      selected ? "border-accent bg-accent text-white" : "border-border-2",
                    )}
                  >
                    {selected && <Check size={12} strokeWidth={3} />}
                  </span>
                )}
                {o.icon !== undefined && <span className="grid flex-none place-items-center">{o.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint && <span className="max-w-[45%] flex-none truncate text-[12px] text-text-3">{o.hint}</span>}
                {!props.multiple && selected && <Check size={15} strokeWidth={2} className="flex-none text-accent" />}
              </button>
            );
          })}
        </div>
        {footer && <div className="border-t border-border p-1">{footer}</div>}
      </div>
    </Popover>
  );
}
