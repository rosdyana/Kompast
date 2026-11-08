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

/**
 * The Kompast compass mark: a navy tile holding one compass needle tilted
 * north-east, lifted-cobalt tip and paper tail. Geometry lives on a 32-unit
 * grid shared with /public/favicon.svg — change one, change both.
 * `bare` drops the tile (for placing the needle on the navy brand panel).
 */
export function CompassMark({ size = 22, className, bare = false }: { size?: number; className?: string; bare?: boolean }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 32 32" className={clsx("flex-none", className)}>
      {!bare && <rect width="32" height="32" rx="9" fill="var(--mark-tile)" />}
      <path d="M25 7 19 19 13 13Z" fill="var(--mark-tip)" />
      <path d="M7 25 13 13 19 19Z" fill="var(--mark-tail)" />
    </svg>
  );
}
