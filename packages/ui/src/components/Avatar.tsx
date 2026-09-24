import clsx from "clsx";
import type { BadgeTone } from "./Badge";

const bgByTone: Record<BadgeTone, string> = {
  neutral: "bg-surface-4 text-text-2",
  accent: "bg-accent-soft text-accent-text",
  indigo: "bg-indigo-soft text-indigo",
  green: "bg-green-soft text-green",
  amber: "bg-amber-soft text-amber",
  violet: "bg-violet-soft text-violet",
  danger: "bg-danger-soft text-danger",
};

const HASH_TONES: BadgeTone[] = ["accent", "green", "amber", "violet", "indigo", "danger"];

export function initialsOf(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

/** Stable per-person tone, so the same teammate is the same color everywhere. */
export function toneForName(seed: string): BadgeTone {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return HASH_TONES[Math.abs(hash) % HASH_TONES.length]!;
}

export interface AvatarProps {
  /** Full name — derives initials and a stable color. Preferred over `initials`. */
  name?: string;
  initials?: string;
  tone?: BadgeTone;
  size?: number;
  title?: string;
  className?: string;
}

export function Avatar({ name, initials, tone, size = 22, title, className }: AvatarProps) {
  const label = initials ?? (name ? initialsOf(name) : "?");
  const resolvedTone = tone ?? (name ? toneForName(name) : "violet");
  return (
    <span
      title={title ?? name}
      aria-label={title ?? name}
      className={clsx(
        "inline-grid flex-none select-none place-items-center rounded-full font-semibold leading-none",
        bgByTone[resolvedTone],
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)) }}
    >
      {label}
    </span>
  );
}

/** Dashed empty avatar for "Unassigned". */
export function UnassignedAvatar({ size = 22, title, className }: { size?: number; title?: string; className?: string }) {
  return (
    <span
      title={title}
      aria-label={title}
      className={clsx("inline-block flex-none rounded-full border border-dashed border-text-3 bg-surface", className)}
      style={{ width: size, height: size }}
    />
  );
}
