/**
 * Duplicated from packages/core/src/board.ts (parseStandupSettings) so core
 * stays out of the client bundle. Keep the two in sync.
 */
export interface StandupSettings {
  didColumnIds: string[];
  todayColumnIds: string[];
}

/** Tolerant reader for the raw jsonb: anything that isn't an array of strings reads as []. */
export function parseStandupSettings(json: unknown): StandupSettings {
  const obj = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const strings = (v: unknown): string[] => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : []);
  return { didColumnIds: strings(obj.didColumnIds), todayColumnIds: strings(obj.todayColumnIds) };
}
