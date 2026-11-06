import { and, eq, schema, sql, type Json } from "@kompast/db";
import type { Tx } from "@kompast/core";

/**
 * Inline attachment references in migrated rich text. The converter (adf-to-blocks.ts)
 * points an image or file block at JIRA's content URL, `<site>/rest/api/3/attachment/content/<id>`.
 * The attachments phase rewrites those URLs once the file is stored, and turns them into
 * plain links when the file is not going to be copied. Everything here works on the stored
 * Block[] JSON (or any other JSON) and only touches `url` and `href` strings.
 */

/** A file over this size is never copied as an inline attachment, whatever the limit says. */
export const INLINE_ATTACHMENT_HARD_CAP_BYTES = 100 * 1024 * 1024;

const CONTENT_URL = /\/attachment\/content\/(\d+)$/;

/** The JIRA attachment id a content URL names, or null for any other URL. */
export function jiraAttachmentIdOfContentUrl(url: string): string | null {
  const m = CONTENT_URL.exec(url);
  return m ? m[1]! : null;
}

/** Every JIRA attachment id referenced by a `url` or `href` string anywhere in the value. */
export function collectInlineAttachmentIds(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectInlineAttachmentIds(item, into);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if ((key === "url" || key === "href") && typeof child === "string") {
        const id = jiraAttachmentIdOfContentUrl(child);
        if (id) into.add(id);
      } else {
        collectInlineAttachmentIds(child, into);
      }
    }
  }
  return into;
}

export interface InlineRewriteResult {
  value: unknown;
  /** How many `url` or `href` strings (or blocks) were rewritten. */
  count: number;
}

/**
 * Points every reference to one JIRA attachment at `newUrl` (the stable Kompast
 * URL, once the file is stored). Returns a new value; the input is not mutated.
 */
export function rewriteAttachmentUrls(value: unknown, jiraAttachmentId: string, newUrl: string): InlineRewriteResult {
  let count = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if ((key === "url" || key === "href") && typeof child === "string" && jiraAttachmentIdOfContentUrl(child) === jiraAttachmentId) {
        out[key] = newUrl;
        count++;
      } else {
        out[key] = walk(child);
      }
    }
    return out;
  };
  return { value: walk(value), count };
}

/**
 * For a file that will not be copied (or failed for good): an image or file block that
 * points at it becomes a paragraph linking to the JIRA page, and an inline link to it
 * points at that page too. Returns a new value; the input is not mutated.
 */
export function linkUnavailableAttachment(
  value: unknown,
  jiraAttachmentId: string,
  target: { fileName: string; sourceUrl: string },
): InlineRewriteResult {
  let count = 0;
  const matches = (url: unknown) => typeof url === "string" && jiraAttachmentIdOfContentUrl(url) === jiraAttachmentId;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.flatMap((item) => {
      const replaced = blockReplacement(item);
      if (replaced) {
        count++;
        return [replaced];
      }
      return [walk(item)];
    });
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === "href" && matches(child)) {
        out[key] = target.sourceUrl;
        count++;
      } else {
        out[key] = walk(child);
      }
    }
    return out;
  };
  // A block-level image or file: the converter's own shape, { type, props: { url, name }, children }.
  const blockReplacement = (item: unknown): unknown | null => {
    if (!item || typeof item !== "object") return null;
    const b = item as { type?: unknown; props?: { url?: unknown } };
    if ((b.type === "image" || b.type === "file") && matches(b.props?.url)) {
      return {
        type: "paragraph",
        props: {},
        content: [
          {
            type: "link",
            href: target.sourceUrl,
            content: [{ type: "text", text: `${target.fileName} (not copied — open in JIRA)`, styles: {} }],
          },
        ],
        children: [],
      };
    }
    return null;
  };
  return { value: walk(value), count };
}

/**
 * Runs `rewrite` over one issue's description and every one of its comment bodies
 * (rows of that issue only), and writes back the rows it changed. Returns the total
 * count the rewrite reported. Rows are pre-filtered in SQL on the content URL's id.
 */
export async function rewriteIssueInlineAttachments(
  tx: Tx,
  issueId: string,
  jiraAttachmentId: string,
  rewrite: (value: unknown) => InlineRewriteResult,
): Promise<number> {
  const needle = `%/attachment/content/${jiraAttachmentId}"%`;
  let total = 0;

  const [issueRow] = await tx
    .select({ descriptionJson: schema.issue.descriptionJson })
    .from(schema.issue)
    .where(and(eq(schema.issue.id, issueId), sql`${schema.issue.descriptionJson}::text like ${needle}`));
  if (issueRow && issueRow.descriptionJson !== null) {
    const result = rewrite(issueRow.descriptionJson);
    if (result.count > 0) {
      await tx.update(schema.issue).set({ descriptionJson: result.value as Json }).where(eq(schema.issue.id, issueId));
      total += result.count;
    }
  }

  const comments = await tx
    .select({ id: schema.issueComment.id, bodyJson: schema.issueComment.bodyJson })
    .from(schema.issueComment)
    .where(and(eq(schema.issueComment.issueId, issueId), sql`${schema.issueComment.bodyJson}::text like ${needle}`));
  for (const comment of comments) {
    const result = rewrite(comment.bodyJson);
    if (result.count > 0) {
      await tx.update(schema.issueComment).set({ bodyJson: result.value as Json }).where(eq(schema.issueComment.id, comment.id));
      total += result.count;
    }
  }

  return total;
}
