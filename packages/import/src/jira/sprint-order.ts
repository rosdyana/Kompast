import { extractJiraSprints, parseJiraSprintNumber } from "./map";
import type { JiraIssue, JiraSprint } from "./types";

/**
 * The one sprint ordering and "current sprint" rule. The loader (its plan, its full load, its sync) and the reconcile
 * (the JIRA side of a sprint comparison) all use these, so they can't disagree about which sprint an issue is on.
 */

const STATE_RANK = { closed: 0, active: 1, future: 2 } as const;

/**
 * The order JIRA sprints are planned in: closed, then active, then future. Within a state, by the number in the name
 * when every sprint in that state has one (start dates aren't reliable: real boards have "Sprint 98" started a few hours
 * before "Sprint 97"); otherwise by start date for closed/active (completed or ended date as the fallback), and by JIRA
 * id for future sprints, as JIRA lists them. Deduped by id; the input isn't mutated.
 */
export function orderJiraSprints(sprints: JiraSprint[]): JiraSprint[] {
  const byId = new Map<number, JiraSprint>();
  for (const s of sprints) byId.set(s.id, s);
  const all = [...byId.values()];
  if (all.length === 0) return [];

  const sortKey = (s: JiraSprint) => toTime(s.startDate) ?? toTime(s.completeDate ?? s.endDate) ?? Number.MAX_SAFE_INTEGER;
  const numberedStates = new Set(
    (["closed", "active", "future"] as const).filter((state) => all.filter((s) => s.state === state).every((s) => parseJiraSprintNumber(s.name) !== null)),
  );
  return all.sort((a, b) => {
    if (a.state !== b.state) return STATE_RANK[a.state] - STATE_RANK[b.state];
    if (numberedStates.has(a.state)) return parseJiraSprintNumber(a.name)! - parseJiraSprintNumber(b.name)! || a.id - b.id;
    if (a.state === "future") return a.id - b.id;
    return sortKey(a) - sortKey(b) || a.id - b.id;
  });
}

/** A sprint as the current-sprint rule sees it: its position in the order (see orderJiraSprints) and whether it is open in Kompast. */
export interface SprintRank {
  order: number;
  open: boolean;
}

/**
 * The JIRA sprint an issue is on now: its last open sprint, or, when the issue is done, its last sprint. `ranks` holds
 * only the sprints Kompast has imported, by JIRA sprint id; the issue's other sprints are ignored. Returns the JIRA
 * sprint id, or null for the backlog.
 */
export function currentJiraSprintIdOf(issue: JiraIssue, ranks: ReadonlyMap<number, SprintRank>): number | null {
  const onSprints = extractJiraSprints(issue)
    .flatMap((s) => {
      const rank = ranks.get(s.id);
      return rank ? [{ id: s.id, rank }] : [];
    })
    .sort((a, b) => a.rank.order - b.rank.order);
  const open = onSprints.filter((p) => p.rank.open);
  const isDone = issue.fields.status.statusCategory.key === "done";
  const current = open.at(-1) ?? (isDone ? onSprints.at(-1) : undefined);
  return current?.id ?? null;
}

function toTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? undefined : t;
}
