/** Joins truthy class names — a dependency-free stand-in for clsx in apps/web. */
export function cn(...parts: Array<string | false | null | undefined | 0>): string {
  return parts.filter(Boolean).join(" ");
}
