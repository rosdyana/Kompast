import type { JiraClient } from "./client";
import { findAttachmentByName, mediaNameOf } from "./adf-to-blocks";
import type { JiraAttachment, JiraChangelogHistory, JiraComment, JiraIssue, JiraUser, JiraWorklogEntry } from "./types";

/**
 * JIRA's search response embeds only a first page of comments, worklogs and
 * changelog entries, and no watcher list at all. This fills each issue in to
 * its full set with the per-issue endpoints, so the loader gets everything
 * without changing what the search returned. Runs before any DB transaction
 * opens (the migration runner calls it straight after fetching a page), so no
 * network call ever happens inside a tx. The client limits concurrency and
 * retries 429/5xx itself.
 *
 * It also resolves inline file media that no filename matches. On JIRA Cloud
 * most inline media carry only a Media Services id, not the attachment id. The
 * rendered HTML lists the attachment ids in document order, so each unmatched
 * file media node is given the id at its position (see assignAttachmentIdsByPosition).
 */

export interface JiraEnrichStats {
  commentPages: number;
  changelogPages: number;
  worklogPages: number;
  watcherCalls: number;
  /** GET issue?expand=renderedFields, one per issue whose description has file media no filename matches. */
  renderedDescriptionCalls: number;
  /** Comment pages fetched only for their rendered HTML (the issue's comments needed no paging). */
  renderedCommentCalls: number;
  /** File media nodes given an attachment id by their position in the rendered HTML. */
  mediaMatchedByPosition: number;
  /** Unmatched file media whose rendered position couldn't be trusted (sizes disagree, the id isn't one of the issue's attachments, or the counts differ). Left unmatched. */
  mediaPositionMismatch: number;
}

const PAGE_SIZE = 100;

interface CommentPage {
  comments?: JiraComment[];
  total?: number;
}
interface WorklogPage {
  worklogs?: JiraWorklogEntry[];
  total?: number;
}
interface ChangelogPage {
  values?: { id?: string; created: string; author?: JiraUser | null; items: JiraChangelogHistory["items"] }[];
  total?: number;
  isLast?: boolean;
}
interface WatcherPage {
  watchers?: JiraUser[];
}
interface RenderedDescriptionPage {
  renderedFields?: { description?: string | null };
}

/** Pages a JIRA "startAt/maxResults" list until it runs out (or reaches its total), collecting every item. */
async function pageAll<Page, Item>(
  fetchPage: (startAt: number) => Promise<Page>,
  read: (page: Page) => { items: Item[]; total?: number; isLast?: boolean },
  onPage: () => void,
): Promise<Item[]> {
  const all: Item[] = [];
  for (let startAt = 0; ; ) {
    const page = await fetchPage(startAt);
    onPage();
    const { items, total, isLast } = read(page);
    all.push(...items);
    startAt += items.length;
    const done = isLast ?? (total !== undefined ? startAt >= total : items.length < PAGE_SIZE);
    if (done || items.length === 0) break;
  }
  return all;
}

// ── Inline file media, by position in JIRA's rendered HTML ──────────────────

interface AdfMediaNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: unknown;
}

/** Every file-type media or mediaInline node, in document order. The nodes are the ADF's own objects, so writing to them writes into the ADF. */
export function fileMediaNodes(adf: unknown): AdfMediaNode[] {
  const out: AdfMediaNode[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const n = node as AdfMediaNode;
    if ((n.type === "media" || n.type === "mediaInline") && n.attrs?.type === "file") out.push(n);
    walk(n.content);
  };
  walk(adf);
  return out;
}

/** A file media node no attachment's filename matches. These are the ones that need JIRA's rendered HTML. */
function hasUnmatchedFileMedia(adf: unknown, attachments: JiraAttachment[]): boolean {
  return fileMediaNodes(adf).some((n) => !findAttachmentByName(attachments, mediaNameOf(n.attrs ?? {})));
}

export interface RenderedAttachmentRef {
  id: string;
  /** Set on an <img> that carries a width attribute. */
  width?: number;
  /** Set on an <img> that carries a height attribute. */
  height?: number;
}

const ATTACHMENT_REF = /attachment\/content\/(\d+)|secure\/attachment\/(\d+)\//g;

/** A numeric attribute of an HTML tag (" width=\"1801\""), or undefined. */
function numericAttr(tag: string, name: string): number | undefined {
  const m = new RegExp(`\\s${name}="(\\d+(?:\\.\\d+)?)"`, "i").exec(tag);
  return m ? Number(m[1]) : undefined;
}

/**
 * The attachment ids in JIRA's rendered HTML, in document order. Each one is an
 * <img> or a link to …/attachment/content/<id> or …/secure/attachment/<id>/<name>.
 * An <img> also carries its width and height, which assignAttachmentIdsByPosition
 * checks against the ADF node.
 */
export function renderedAttachmentRefs(html: string): RenderedAttachmentRef[] {
  const out: RenderedAttachmentRef[] = [];
  for (const tag of html.match(/<[^>]*>/g) ?? []) {
    const isImg = /^<img\b/i.test(tag);
    const width = isImg ? numericAttr(tag, "width") : undefined;
    const height = isImg ? numericAttr(tag, "height") : undefined;
    for (const m of tag.matchAll(ATTACHMENT_REF)) {
      out.push({ id: (m[1] ?? m[2])!, width, height });
    }
  }
  return out;
}

export interface PositionalAttachmentResult {
  /** A copy of the ADF with __attachmentId written onto the nodes that were matched by position. */
  adf: unknown;
  matched: number;
  mismatch: number;
}

/**
 * Gives each unmatched file media node the attachment id at its position in the rendered HTML.
 *
 * Every file media node counts toward the positions, including those a filename already
 * matched, so the positions line up with the HTML. Nothing is assigned unless the two lists
 * have the same length: a missing or doubled node would shift every position after it. Within
 * a matched pair, a width or height that disagrees (both sides have one) leaves the node
 * unmatched. Works on a copy; the input is untouched.
 */
export function assignAttachmentIdsByPosition(adf: unknown, attachments: JiraAttachment[], refs: RenderedAttachmentRef[]): PositionalAttachmentResult {
  const copy = JSON.parse(JSON.stringify(adf)) as unknown;
  const nodes = fileMediaNodes(copy);
  const isMatchedByName = (node: AdfMediaNode) => !!findAttachmentByName(attachments, mediaNameOf(node.attrs ?? {}));
  const unmatchedCount = nodes.filter((n) => !isMatchedByName(n)).length;
  if (unmatchedCount === 0) return { adf: copy, matched: 0, mismatch: 0 };
  if (refs.length !== nodes.length) return { adf: copy, matched: 0, mismatch: unmatchedCount };

  let matched = 0;
  let mismatch = 0;
  nodes.forEach((node, i) => {
    if (isMatchedByName(node)) return;
    const ref = refs[i]!;
    const attrs = node.attrs ?? {};
    const adfWidth = typeof attrs.width === "number" ? attrs.width : undefined;
    const adfHeight = typeof attrs.height === "number" ? attrs.height : undefined;
    const sizesDiffer = (ref.width !== undefined && adfWidth !== undefined && ref.width !== adfWidth) || (ref.height !== undefined && adfHeight !== undefined && ref.height !== adfHeight);
    if (sizesDiffer || !attachments.some((a) => a.id === ref.id)) {
      mismatch++;
      return;
    }
    attrs.__attachmentId = ref.id;
    matched++;
  });
  return { adf: copy, matched, mismatch };
}

// ── Enrichment ──────────────────────────────────────────────────────────────

/**
 * Returns new issue objects (the inputs aren't mutated) with comments, changelog
 * and worklogs filled to JIRA's real totals, watchersList set where JIRA says
 * there are watchers, and attachment ids written onto inline file media that
 * the rendered HTML resolves. Issues that are already complete and need no
 * media resolution cost no requests.
 */
export async function enrichJiraIssues(client: JiraClient, issues: JiraIssue[]): Promise<{ issues: JiraIssue[]; stats: JiraEnrichStats }> {
  const stats: JiraEnrichStats = {
    commentPages: 0,
    changelogPages: 0,
    worklogPages: 0,
    watcherCalls: 0,
    renderedDescriptionCalls: 0,
    renderedCommentCalls: 0,
    mediaMatchedByPosition: 0,
    mediaPositionMismatch: 0,
  };
  const base = (key: string) => `/rest/api/3/issue/${encodeURIComponent(key)}`;

  const enriched = await Promise.all(
    issues.map(async (issue): Promise<JiraIssue> => {
      let next: JiraIssue = issue;
      const attachments = issue.fields.attachment ?? [];

      if (hasUnmatchedFileMedia(issue.fields.description, attachments)) {
        stats.renderedDescriptionCalls++;
        const page = await client.get<RenderedDescriptionPage>(base(issue.key), { fields: "description", expand: "renderedFields" });
        const resolved = assignAttachmentIdsByPosition(issue.fields.description, attachments, renderedAttachmentRefs(page.renderedFields?.description ?? ""));
        stats.mediaMatchedByPosition += resolved.matched;
        stats.mediaPositionMismatch += resolved.mismatch;
        next = { ...next, fields: { ...next.fields, description: resolved.adf as typeof next.fields.description } };
      }

      // Comments. Every paged call also asks for renderedBody, so a comment past the first page
      // needs no second pass. The rendered-only case (no paging needed) is one call, the same.
      const comment = issue.fields.comment;
      const commentTotal = comment?.total ?? 0;
      const embeddedComments = comment?.comments ?? [];
      const pagingNeeded = commentTotal > embeddedComments.length;
      const renderedNeeded = !pagingNeeded && embeddedComments.some((c) => hasUnmatchedFileMedia(c.body, attachments));
      if (pagingNeeded || renderedNeeded) {
        const comments = await pageAll<CommentPage, JiraComment>(
          (startAt) => client.get<CommentPage>(`${base(issue.key)}/comment`, { startAt, maxResults: PAGE_SIZE, expand: "renderedBody" }),
          (page) => ({ items: page.comments ?? [], total: page.total ?? commentTotal }),
          () => (pagingNeeded ? stats.commentPages++ : stats.renderedCommentCalls++),
        );
        const resolvedComments = comments.map((c) => {
          if (!hasUnmatchedFileMedia(c.body, attachments)) return c;
          const resolved = assignAttachmentIdsByPosition(c.body, attachments, renderedAttachmentRefs(c.renderedBody ?? ""));
          stats.mediaMatchedByPosition += resolved.matched;
          stats.mediaPositionMismatch += resolved.mismatch;
          return { ...c, body: resolved.adf };
        });
        next = { ...next, fields: { ...next.fields, comment: { comments: resolvedComments, total: commentTotal } } };
      }

      const changelog = issue.changelog;
      const changelogTotal = changelog?.total ?? 0;
      if (changelogTotal > (changelog?.histories.length ?? 0)) {
        const values = await pageAll<ChangelogPage, NonNullable<ChangelogPage["values"]>[number]>(
          (startAt) => client.get<ChangelogPage>(`${base(issue.key)}/changelog`, { startAt, maxResults: PAGE_SIZE }),
          (page) => ({ items: page.values ?? [], total: page.total ?? changelogTotal, isLast: page.isLast }),
          () => stats.changelogPages++,
        );
        const histories: JiraChangelogHistory[] = values.map((v) => ({ id: v.id, created: v.created, author: v.author ?? null, items: v.items }));
        next = { ...next, changelog: { histories, total: changelogTotal } };
      }

      const worklog = issue.fields.worklog;
      const worklogTotal = worklog?.total ?? 0;
      if (worklogTotal > (worklog?.worklogs.length ?? 0)) {
        const worklogs = await pageAll<WorklogPage, JiraWorklogEntry>(
          (startAt) => client.get<WorklogPage>(`${base(issue.key)}/worklog`, { startAt, maxResults: PAGE_SIZE }),
          (page) => ({ items: page.worklogs ?? [], total: page.total ?? worklogTotal }),
          () => stats.worklogPages++,
        );
        next = { ...next, fields: { ...next.fields, worklog: { worklogs, total: worklogTotal } } };
      }

      if ((issue.fields.watches?.watchCount ?? 0) > 0) {
        stats.watcherCalls++;
        const page = await client.get<WatcherPage>(`${base(issue.key)}/watchers`);
        next = { ...next, watchersList: page.watchers ?? [] };
      }

      return next;
    }),
  );

  return { issues: enriched, stats };
}
