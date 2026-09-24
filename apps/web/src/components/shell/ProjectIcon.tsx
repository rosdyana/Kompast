import { cn as clsx } from "@/lib/cn";

const TILE_COLORS = ["var(--tile-1)", "var(--tile-2)", "var(--tile-3)", "var(--tile-4)", "var(--tile-5)", "var(--tile-6)", "var(--tile-7)"];

function colorFor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return TILE_COLORS[Math.abs(hash) % TILE_COLORS.length]!;
}

/** Jira-style project avatar: a small rounded tile with the key's first letter. */
export function ProjectIcon({ projectKey, size = 20, className }: { projectKey: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx("inline-grid flex-none place-items-center rounded-[5px] font-bold leading-none text-white", className)}
      style={{ width: size, height: size, background: colorFor(projectKey), fontSize: Math.round(size * 0.5) }}
    >
      {projectKey.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The Kompast compass mark: navy tile, cobalt diamond. */
export function CompassMark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx("inline-grid flex-none place-items-center bg-indigo", className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
    >
      <span className="rotate-45 rounded-[2px] bg-accent" style={{ width: size * 0.3, height: size * 0.3 }} />
    </span>
  );
}
