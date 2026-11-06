/**
 * The JQL a catch-up sync reads with. JQL reads a date in the time zone of the account the token belongs to, so the
 * timestamp is written in that zone (JIRA's /myself `timeZone`), not in UTC. Pure functions, no network.
 */

/** The zone to format JQL dates in: the account's own zone, or UTC when JIRA didn't say (or names a zone Intl doesn't know). */
export function resolveTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** `yyyy/MM/dd HH:mm` for an instant, read in `timeZone`. The form JQL accepts for a date and time. */
export function jqlTimestampIn(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}/${part("month")}/${part("day")} ${part("hour")}:${part("minute")}`;
}

function quoteJql(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Issues of the project updated at or after `since`, oldest change first. */
export function changedSinceJql(projectKey: string, since: Date, timeZone: string): string {
  return `project = ${quoteJql(projectKey)} AND updated >= ${quoteJql(jqlTimestampIn(since, timeZone))} ORDER BY updated ASC, key ASC`;
}

/** Every issue key of the project, oldest first: the list a sync compares Kompast's imported keys with. */
export function projectKeysJql(projectKey: string): string {
  return `project = ${quoteJql(projectKey)} ORDER BY key ASC`;
}
