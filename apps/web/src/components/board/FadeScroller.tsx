import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "@kompast/i18n";
import { cn } from "@/lib/cn";

interface Edges {
  above: boolean;
  below: boolean;
  /** Cards not fully visible below the fold. */
  more: number;
}

const NONE: Edges = { above: false, below: false, more: 0 };

/**
 * A vertical scroll area for board cards (an ungrouped column, or one cell of a
 * capped swimlane) that shows where more content is: a soft fade at the top once
 * scrolled, a fade at the bottom while more is below, and a "↓ N more" pill.
 * Overlay scrollbars (macOS) stay hidden until you scroll, so without this a cut-off
 * column looks the same as one that simply ends.
 *
 * The fades sit outside the scroller (so they don't scroll away) and ignore the
 * pointer, so clicks, drags and drops pass straight through to the cards.
 * Cards are found by `data-board-card`.
 */
export function FadeScroller({ className, scrollClassName, children }: { className?: string; scrollClassName?: string; children: ReactNode }) {
  const { t } = useTranslation("board");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>(NONE);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      const visibleBottom = el.getBoundingClientRect().bottom;
      let more = 0;
      if (below) for (const card of el.querySelectorAll("[data-board-card]")) if (card.getBoundingClientRect().bottom > visibleBottom + 1) more++;
      const next = { above: el.scrollTop > 1, below, more };
      setEdges((prev) => (prev.above === next.above && prev.below === next.below && prev.more === next.more ? prev : next));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // The scroller resizes with its column/lane; its content resizes as cards are added, moved or edited.
    const observer = new ResizeObserver(update);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  });

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)}>
      {/* `relative` keeps cards' absolutely positioned bits (sr-only labels) inside this scroll clip. */}
      <div ref={scrollRef} data-fade-scroller className={cn("relative flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:thin]", scrollClassName)}>
        {children}
      </div>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-6 bg-linear-to-b from-surface-2 to-transparent transition-opacity duration-150",
          edges.above ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 flex h-12 items-end justify-center rounded-b-[10px] bg-linear-to-t from-surface-2 from-30% to-transparent pb-1.5 transition-opacity duration-150",
          edges.below ? "opacity-100" : "opacity-0",
        )}
      >
        {edges.more > 0 && (
          <span className="rounded-full bg-surface px-2 py-0.5 text-[11.5px] font-medium tabular-nums text-text-2 shadow-card">
            ↓ {t("boardView.moreBelow", { count: edges.more })}
          </span>
        )}
      </div>
    </div>
  );
}
