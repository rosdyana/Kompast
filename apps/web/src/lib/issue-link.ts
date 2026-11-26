/** The issue detail route's path. teamId is "none" for a project with no team, matching the route. */
export function issuePath(ref: { teamId: string | null; projectKey: string; keySeq: number | string }): string {
  return `/issues/${encodeURIComponent(ref.teamId || "none")}/${encodeURIComponent(ref.projectKey)}/${ref.keySeq}`;
}

/**
 * Parses an absolute issue URL from this Kompast instance (`origin`) into its
 * route params. Query strings (`?from=board`) and hashes are ignored. Returns
 * null for anything else: another host, another route, a relative string, or
 * text that only contains a URL among other words.
 */
export function parseIssueUrl(text: string, origin: string): { teamId: string; projectKey: string; keySeq: number } | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const match = /^\/issues\/([^/]+)\/([^/]+)\/(\d+)\/?$/.exec(url.pathname);
  if (!match) return null;
  const keySeq = Number(match[3]);
  if (!Number.isSafeInteger(keySeq) || keySeq <= 0) return null;
  try {
    return { teamId: decodeURIComponent(match[1]!), projectKey: decodeURIComponent(match[2]!), keySeq };
  } catch {
    return null;
  }
}
