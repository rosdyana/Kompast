/**
 * Tool arguments arrive as streamed JSON text. A malformed or truncated payload
 * is surfaced as `{ _raw }` rather than thrown, so one bad tool call doesn't
 * abort the whole answer; the tool's own input validation reports the problem.
 */
export function parseToolInput(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}
