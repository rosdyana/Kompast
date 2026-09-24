import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";

export type PopoverPlacement = "bottom-start" | "bottom-end" | "top-start" | "top-end" | "right-start";

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  placement?: PopoverPlacement;
  /** Fixed width in px, or "anchor" to match the trigger's width. */
  width?: number | "anchor";
  minWidth?: number;
  offset?: number;
  className?: string;
  /** Extra elements whose clicks should not count as "outside". */
  ignoreRefs?: RefObject<HTMLElement | null>[];
  role?: string;
  ariaLabel?: string;
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Floating panel anchored to a trigger, portaled to <body> with
 * position:fixed so no overflow:hidden/auto ancestor (table wrappers, the
 * board's scroll container, the sidebar) can clip it. Flips above the
 * trigger when there isn't room below. Closes on outside pointerdown and
 * Escape; the caller owns `open`.
 */
export function Popover({
  open,
  onClose,
  anchorRef,
  children,
  placement = "bottom-start",
  width,
  minWidth = 180,
  offset = 6,
  className,
  ignoreRefs,
  role = "dialog",
  ariaLabel,
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", top: -9999, left: -9999 });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const a = anchor.getBoundingClientRect();
    const pw = width === "anchor" ? a.width : width ?? Math.max(minWidth, panel.offsetWidth);
    const ph = panel.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;

    let top: number;
    let left: number;
    if (placement === "right-start") {
      left = a.right + offset;
      top = a.top;
      if (left + pw > vw - margin) left = a.left - pw - offset;
    } else {
      const wantsTop = placement.startsWith("top");
      const spaceBelow = vh - a.bottom - margin;
      const spaceAbove = a.top - margin;
      const goTop = wantsTop ? spaceAbove >= ph || spaceAbove > spaceBelow : spaceBelow < ph && spaceAbove > spaceBelow;
      top = goTop ? a.top - ph - offset : a.bottom + offset;
      left = placement.endsWith("end") ? a.right - pw : a.left;
    }
    left = Math.min(Math.max(margin, left), vw - pw - margin);
    top = Math.min(Math.max(margin, top), Math.max(margin, vh - ph - margin));
    setStyle({
      position: "fixed",
      top,
      left,
      width: width === "anchor" ? a.width : width,
      minWidth: width === undefined ? minWidth : undefined,
      maxHeight: vh - margin * 2,
    });
  }, [anchorRef, minWidth, offset, placement, width]);

  useIsoLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const ro = typeof ResizeObserver !== "undefined" && panel ? new ResizeObserver(() => reposition()) : null;
    if (ro && panel) ro.observe(panel);
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      if (ignoreRefs?.some((r) => r.current?.contains(target))) return;
      onCloseRef.current();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        anchorRef.current?.focus?.();
      }
    }
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, reposition, anchorRef, ignoreRefs]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={ariaLabel}
      style={style}
      className={clsx(
        "kp-anim-pop z-[70] flex flex-col overflow-hidden rounded-[8px] border border-border bg-surface text-text shadow-kp",
        className,
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Small open/close state helper paired with a trigger ref. */
export function useDisclosure<T extends HTMLElement = HTMLButtonElement>(initial = false) {
  const [open, setOpen] = useState(initial);
  const anchorRef = useRef<T>(null);
  return {
    open,
    setOpen,
    anchorRef,
    toggle: () => setOpen((v) => !v),
    close: () => setOpen(false),
    show: () => setOpen(true),
  };
}
