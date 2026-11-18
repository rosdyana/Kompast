import { and, asc, eq, inArray, schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";
import { InvalidInputError, NotFoundError } from "./errors";
import { notify } from "./notification";

/** UTF-16 length cap on a reaction, so a pasted paragraph can't be stored as an "emoji". */
const MAX_REACTION_EMOJI_UTF16 = 32;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A grapheme counts as an emoji if it has a pictographic code point, is a regional-indicator pair (flag), or is a keycap sequence. */
const EMOJI_GRAPHEME = /\p{Extended_Pictographic}|^\p{Regional_Indicator}{2}$|^[0-9#*]️?⃣$/u;

/**
 * Validates a reaction and returns it trimmed. Exactly one grapheme must be
 * an emoji, so ZWJ families, skin tones, flags and keycaps pass while text,
 * several emoji in a row, or an empty string are rejected.
 */
export function normalizeReactionEmoji(input: string): string {
  const emoji = input.trim();
  if (emoji.length === 0) throw new InvalidInputError("Reaction emoji is required");
  if (emoji.length > MAX_REACTION_EMOJI_UTF16) throw new InvalidInputError("Reaction emoji is too long");
  const graphemes = [...graphemeSegmenter.segment(emoji)].map((g) => g.segment);
  const only = graphemes[0];
  if (graphemes.length !== 1 || only === undefined || !EMOJI_GRAPHEME.test(only)) {
    throw new InvalidInputError("Reaction must be a single emoji");
  }
  return stripRedundantVariationSelector(emoji);
}

/**
 * "👍" and "👍️" (with U+FE0F, the emoji-presentation selector) are the same
 * reaction, but different strings — the picker's data includes the selector,
 * a typed or API-sent emoji usually doesn't — so they'd show as two chips.
 * Drop it where the base character already displays as emoji by default.
 * Characters that need it to render as emoji (❤️, ☀️, keycaps) keep it.
 */
function stripRedundantVariationSelector(emoji: string): string {
  const match = /^(\p{Emoji_Presentation})\u{FE0F}$/u.exec(emoji);
  return match ? match[1]! : emoji;
}

export interface AddCommentReactionInput {
  organizationId: string;
  commentId: string;
  userId: string;
  emoji: string;
  origin: "user" | "automation" | "mcp" | "api" | "import";
  originClient?: string;
}

/**
 * Adds the caller's reaction to a comment. Idempotent: a repeat add is a
 * no-op and notifies nobody. The comment is looked up through the caller's
 * RLS identity, so a comment on an issue the caller can't see is NotFound.
 * The author is notified in-app (no email) only for a new reaction by someone
 * else, and never for imported data.
 */
export async function addCommentReaction(tx: Tx, input: AddCommentReactionInput): Promise<{ added: boolean }> {
  const emoji = normalizeReactionEmoji(input.emoji);

  const [comment] = await tx
    .select({
      issueId: schema.issueComment.issueId,
      authorId: schema.issueComment.authorId,
      keySeq: schema.issue.keySeq,
      projectKey: schema.project.key,
    })
    .from(schema.issueComment)
    .innerJoin(schema.issue, eq(schema.issue.id, schema.issueComment.issueId))
    .innerJoin(schema.project, eq(schema.project.id, schema.issue.projectId))
    .where(eq(schema.issueComment.id, input.commentId));
  if (!comment) throw new NotFoundError(`Comment ${input.commentId} not found`);

  const inserted = await tx
    .insert(schema.issueCommentReaction)
    .values({
      id: id("cmtreact"),
      commentId: input.commentId,
      userId: input.userId,
      emoji,
      origin: input.origin,
      originClient: input.originClient,
    })
    .onConflictDoNothing()
    .returning({ id: schema.issueCommentReaction.id });
  const added = inserted.length > 0;

  if (added && comment.authorId !== input.userId && input.origin !== "import") {
    const [reactor] = await tx.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, input.userId));
    const issueKey = `${comment.projectKey}-${comment.keySeq}`;
    await notify(tx, {
      organizationId: input.organizationId,
      userId: comment.authorId,
      eventType: "issue.comment_reacted",
      entityType: "issue",
      entityId: comment.issueId,
      title: `${reactor?.name ?? "Someone"} reacted ${emoji} to your comment on ${issueKey}`,
    });
  }

  return { added };
}

export interface RemoveCommentReactionInput {
  commentId: string;
  userId: string;
  emoji: string;
}

/** Removes only the caller's own reaction. Idempotent: removing a reaction that isn't there is a no-op. */
export async function removeCommentReaction(tx: Tx, input: RemoveCommentReactionInput): Promise<{ removed: boolean }> {
  const emoji = normalizeReactionEmoji(input.emoji);
  const deleted = await tx
    .delete(schema.issueCommentReaction)
    .where(
      and(
        eq(schema.issueCommentReaction.commentId, input.commentId),
        eq(schema.issueCommentReaction.userId, input.userId),
        eq(schema.issueCommentReaction.emoji, emoji),
      ),
    )
    .returning({ id: schema.issueCommentReaction.id });
  return { removed: deleted.length > 0 };
}

export interface CommentReactionSummary {
  emoji: string;
  count: number;
  userIds: string[];
}

/**
 * Reactions for many comments in one query. Each comment's emoji are ordered
 * by when they were first reacted with; userIds are in reaction order.
 */
export async function listCommentReactions(tx: Tx, commentIds: string[]): Promise<Map<string, CommentReactionSummary[]>> {
  const result = new Map<string, CommentReactionSummary[]>();
  if (commentIds.length === 0) return result;

  const rows = await tx
    .select({
      commentId: schema.issueCommentReaction.commentId,
      userId: schema.issueCommentReaction.userId,
      emoji: schema.issueCommentReaction.emoji,
    })
    .from(schema.issueCommentReaction)
    .where(inArray(schema.issueCommentReaction.commentId, commentIds))
    .orderBy(asc(schema.issueCommentReaction.createdAt));

  for (const row of rows) {
    let summaries = result.get(row.commentId);
    if (!summaries) {
      summaries = [];
      result.set(row.commentId, summaries);
    }
    let summary = summaries.find((s) => s.emoji === row.emoji);
    if (!summary) {
      summary = { emoji: row.emoji, count: 0, userIds: [] };
      summaries.push(summary);
    }
    summary.count += 1;
    summary.userIds.push(row.userId);
  }
  return result;
}
