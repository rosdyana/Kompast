import clsx from "clsx";
import { ChevronDown, ChevronUp, ChevronsDown, ChevronsUp, Equal, type LucideIcon } from "lucide-react";

export interface PriorityLike {
  key: string;
  name: string;
  color?: string | null;
}

const BY_KEY: Record<string, { Icon: LucideIcon; color: string }> = {
  critical: { Icon: ChevronsUp, color: "var(--danger)" },
  highest: { Icon: ChevronsUp, color: "var(--danger)" },
  blocker: { Icon: ChevronsUp, color: "var(--danger)" },
  high: { Icon: ChevronUp, color: "color-mix(in srgb, var(--danger) 70%, var(--amber))" },
  medium: { Icon: Equal, color: "var(--amber)" },
  low: { Icon: ChevronDown, color: "var(--accent)" },
  very_low: { Icon: ChevronsDown, color: "var(--accent)" },
  lowest: { Icon: ChevronsDown, color: "var(--accent)" },
};

/**
 * Jira-style priority arrow. The five seeded keys map to the familiar
 * chevrons; admin-created levels fall back to a dot in their own color.
 */
export function PriorityIcon({
  priority,
  size = 16,
  className,
  showLabel = false,
}: {
  priority: PriorityLike | null | undefined;
  size?: number;
  className?: string;
  showLabel?: boolean;
}) {
  if (!priority) return null;
  const glyph = BY_KEY[priority.key];
  return (
    <span title={priority.name} className={clsx("inline-flex flex-none items-center gap-1.5", className)}>
      {glyph ? (
        <glyph.Icon size={size} strokeWidth={2.5} style={{ color: glyph.color }} aria-hidden />
      ) : (
        <span
          aria-hidden
          className="grid flex-none place-items-center"
          style={{ width: size, height: size }}
        >
          <span className="h-2 w-2 rounded-full" style={{ background: priority.color ?? "var(--text3)" }} />
        </span>
      )}
      {showLabel ? <span className="truncate">{priority.name}</span> : <span className="sr-only">{priority.name}</span>}
    </span>
  );
}
