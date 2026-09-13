import type { Json } from "@kompast/db";

/**
 * One enclosing loop_each iteration. `itemType` distinguishes a loop over
 * plain values from a loop over issue ids — the latter is what lets a
 * schedule-triggered workflow (whose run has no issueId of its own) reach
 * issue-touching action nodes, via resolveIssueId in automation-execution.ts.
 */
export interface IterationFrame {
  loopKey: string;
  index: number;
  item: Json;
  itemType: "value" | "issueId";
}

export interface ExpressionContext {
  trigger: { issueId?: string; payload?: Json };
  /** Keyed by node.name ?? node.id — every step that has SUCCEEDED so far in this run. */
  steps: Record<string, { output: Json }>;
  /** The innermost enclosing loop's current item, or null outside any loop. Shorthand for loop[<innermost loopKey>]. */
  item: Json | null;
  /** Every enclosing loop's current item, keyed by loopKey — for reaching an outer loop's item from inside a nested one. */
  loop: Record<string, Json>;
}

const WHOLE_EXPR_RE = /^\{\{\s*([\w.$-]+)\s*\}\}$/;
const EXPR_RE = /\{\{\s*([\w.$-]+)\s*\}\}/g;

function getPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveString(template: string, ctx: ExpressionContext): Json {
  const whole = template.match(WHOLE_EXPR_RE);
  if (whole) return (getPath(ctx, whole[1]!) as Json) ?? null;
  return template.replace(EXPR_RE, (_match, path: string) => {
    const value = getPath(ctx, path);
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

/**
 * Deep-walks a jsonb node config, substituting every {{dot.path}} token
 * against `ctx`. Dot-path lookup only — deliberately no JS `eval`/`Function`
 * expression language (this engine's action_webhook node is already an
 * SSRF-guarded outbound-fetch primitive reachable by any issues:write user;
 * adding an arbitrary-code-execution surface on top of that would be a real
 * security regression, not just scope creep).
 */
export function resolveTemplates(value: Json, ctx: ExpressionContext): Json {
  if (typeof value === "string") return resolveString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplates(v, ctx)]));
  }
  return value;
}

export function buildLoopContextFields(frames: IterationFrame[]): Pick<ExpressionContext, "item" | "loop"> {
  return {
    item: frames.at(-1)?.item ?? null,
    loop: Object.fromEntries(frames.map((f) => [f.loopKey, f.item])),
  };
}
