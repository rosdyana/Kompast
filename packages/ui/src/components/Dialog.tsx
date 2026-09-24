import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { X } from "lucide-react";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** Vertical placement: centered, or pinned near the top (command palette). */
  align?: "center" | "top";
  className?: string;
  closeLabel?: string;
  /** Hide the header row entirely (the palette draws its own). */
  bare?: boolean;
}

const SIZES = { sm: "max-w-[420px]", md: "max-w-[560px]", lg: "max-w-[720px]", xl: "max-w-[920px]" };

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog: portaled, scroll-locked, Escape/backdrop to close, focus
 * moved inside on open (first [data-autofocus] or focusable) and restored
 * to the opener on close, Tab cycling kept inside the panel.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  align = "center",
  className,
  closeLabel = "Close",
  bare = false,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = panel.querySelector<HTMLElement>("[data-autofocus]") ?? panel.querySelector<HTMLElement>(FOCUSABLE);
      (target ?? panel).focus();
    });
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const nodes = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={clsx(
        "kp-anim-fade fixed inset-0 z-[60] flex justify-center overflow-y-auto bg-[var(--overlay)] px-4",
        align === "top" ? "items-start pt-[12vh]" : "items-center py-8",
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={clsx(
          "kp-anim-pop flex max-h-[min(86vh,900px)] w-full flex-col overflow-hidden rounded-[10px] border border-border bg-surface text-text shadow-kp outline-none",
          SIZES[size],
          className,
        )}
      >
        {!bare && (title || description) && (
          <div className="flex flex-none items-start gap-3 px-5 pb-3 pt-4">
            <div className="min-w-0 flex-1">
              {title && <h2 className="type-headline text-[17px]">{title}</h2>}
              {description && <p className="mt-0.5 type-small text-text-2">{description}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              className="-mr-1.5 grid h-7 w-7 flex-none place-items-center rounded-[6px] text-text-3 hover:bg-surface-3 hover:text-text"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        )}
        <div className={clsx("min-h-0 flex-1 overflow-y-auto", !bare && "px-5 pb-4")}>{children}</div>
        {footer && (
          <div className="flex flex-none items-center justify-end gap-2 border-t border-border bg-surface-2 px-5 py-3">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
