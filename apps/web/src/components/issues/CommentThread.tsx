import { useEffect, useRef, useState } from "react";
import { ClientOnly } from "@tanstack/react-router";
import type { Block, PartialBlock } from "@blocknote/core";
import { Languages, SmilePlus } from "lucide-react";
import { Avatar } from "@kompast/ui/Avatar";
import { Button } from "@kompast/ui/Button";
import { Popover } from "@kompast/ui/Popover";
import { useToast } from "@kompast/ui/Toast";
import { SUPPORTED_LOCALES, useTranslation, type SupportedLocale } from "@kompast/i18n";
import { EmojiPicker } from "@/components/shared/EmojiPicker";
import { LiteEditor } from "@/components/shared/LiteEditor";
import { LanguageMenu, TranslatableContent } from "@/components/shared/TranslatableContent";
import { LOCALE_LANGUAGE, translateContent } from "@/lib/translate-content";
import { fullDateTime, relativeTime } from "./time";

export interface ThreadReaction {
  emoji: string;
  count: number;
  userIds: string[];
  reactedByMe: boolean;
}

export interface ThreadComment {
  id: string;
  authorId: string;
  bodyJson: unknown;
  parentCommentId: string | null;
  depth: number;
  createdAt: string | Date;
  reactions: ThreadReaction[];
}

export interface ToggleReactionInput {
  commentId: string;
  emoji: string;
  on: boolean;
}

type UsersById = Map<string, { id: string; name: string }>;

interface CommentThreadProps {
  comments: ThreadComment[];
  usersById: UsersById;
  intlLocale: string;
  currentUserId?: string;
  currentUserName?: string;
  onSubmit: (input: { bodyJson: Block[]; parentCommentId?: string }) => Promise<void>;
  /** Persists one reaction on or off. Rejects on failure; the chip then rolls back. */
  onToggleReaction?: (input: ToggleReactionInput) => Promise<void>;
  /** "newest" puts the composer on top and newest comments first (Jira default). */
  order?: "newest" | "oldest";
}

/** The reaction list with `emoji` turned on or off for `userId`, leaving the input untouched. */
function applyReactionToggle(reactions: ThreadReaction[], emoji: string, on: boolean, userId: string): ThreadReaction[] {
  const existing = reactions.find((r) => r.emoji === emoji);
  if (on) {
    if (!existing) return [...reactions, { emoji, count: 1, userIds: [userId], reactedByMe: true }];
    if (existing.reactedByMe) return reactions;
    return reactions.map((r) => (r.emoji === emoji ? { ...r, count: r.count + 1, userIds: [...r.userIds, userId], reactedByMe: true } : r));
  }
  if (!existing || !existing.reactedByMe) return reactions;
  const remaining = existing.count - 1;
  if (remaining <= 0) return reactions.filter((r) => r.emoji !== emoji);
  return reactions.map((r) =>
    r.emoji === emoji ? { ...r, count: remaining, userIds: r.userIds.filter((id) => id !== userId), reactedByMe: false } : r,
  );
}

/**
 * Single-level plain-text excerpt for the reply quote — packages/core's
 * toPlainText can't be bundled client-side (it pulls in the Postgres
 * driver), so this intentionally minimal copy lives here.
 */
function blocksToPlainText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      const content = block && typeof block === "object" && Array.isArray((block as { content?: unknown }).content) ? (block as { content: unknown[] }).content : [];
      return content
        .map((c) => {
          if (!c || typeof c !== "object") return "";
          const node = c as { type?: string; text?: string; props?: { name?: string; projectKey?: string; keySeq?: string } };
          if (node.type === "text") return String(node.text ?? "");
          if (node.type === "userMention") return `@${node.props?.name ?? ""}`;
          if (node.type === "issueMention") return `${node.props?.projectKey}-${node.props?.keySeq}`;
          return "";
        })
        .join("");
    })
    .join("\n")
    .trim();
}

/**
 * Jira's comment box: a one-line "Add a comment…" affordance that expands
 * into the rich editor on click. ⌘/Ctrl+Enter saves; Escape collapses when
 * the draft is empty.
 */
export function CommentComposer({
  onSubmit,
  onCancel,
  autoFocus,
  authorName,
  startExpanded = false,
}: {
  onSubmit: (bodyJson: Block[]) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
  authorName?: string;
  startExpanded?: boolean;
}) {
  const { t } = useTranslation("issue");
  const [expanded, setExpanded] = useState(startExpanded);
  const [draft, setDraft] = useState<Block[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Remounts the uncontrolled editor (clearing it) only after a successful
  // submit — a failed submit keeps the draft.
  const [submitCount, setSubmitCount] = useState(0);
  // Separate remount for a translated draft, which replaces the editor's content.
  const [translateCount, setTranslateCount] = useState(0);
  const [initialContent, setInitialContent] = useState<PartialBlock[] | undefined>(undefined);
  const [translating, setTranslating] = useState(false);
  const toast = useToast();
  // Bumped on submit/cancel so a translation that lands after them is discarded.
  const epochRef = useRef(0);
  const hasContent = blocksToPlainText(draft).length > 0 || draft.some((b) => b.type !== "paragraph");

  async function submit() {
    if (!hasContent || submitting || translating) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(draft);
      epochRef.current += 1;
      setDraft([]);
      setInitialContent(undefined);
      setSubmitCount((c) => c + 1);
      if (!startExpanded) setExpanded(false);
    } catch (err) {
      setError(t("saveFailed", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSubmitting(false);
    }
  }

  /** Replaces the draft with its translation. The author still reviews it and posts it themselves. */
  async function translateDraft(target: SupportedLocale) {
    if (!hasContent || submitting || translating) return;
    const epoch = epochRef.current;
    setTranslating(true);
    try {
      const blocks = await translateContent(draft, LOCALE_LANGUAGE[target]);
      if (epoch !== epochRef.current) return;
      setDraft(blocks as Block[]);
      setInitialContent(blocks);
      setTranslateCount((c) => c + 1);
    } catch (err) {
      if (epoch === epochRef.current) {
        toast.show({ title: t("translateFailed", { message: err instanceof Error ? err.message : String(err) }), tone: "error" });
      }
    } finally {
      setTranslating(false);
    }
  }

  function cancel() {
    epochRef.current += 1;
    setDraft([]);
    setInitialContent(undefined);
    setSubmitCount((c) => c + 1);
    setExpanded(false);
    onCancel?.();
  }

  return (
    <div className="flex gap-3">
      {authorName && <Avatar name={authorName} size={28} className="mt-0.5" />}
      <div className="min-w-0 flex-1">
        {!expanded ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex h-10 w-full items-center rounded-[6px] border border-border-2 bg-surface px-3 text-left text-[14px] text-text-3 hover:border-text-3"
          >
            {t("commentAddPlaceholder")}
          </button>
        ) : (
          <div
            className="flex flex-col gap-2"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape" && !hasContent) {
                e.preventDefault();
                cancel();
              }
            }}
          >
            <ClientOnly fallback={<div className="min-h-[96px] rounded-[6px] border border-border-2 bg-surface" />}>
              <LiteEditor
                key={`${submitCount}:${translateCount}`}
                initialContent={initialContent}
                onChange={setDraft}
                autoFocus={autoFocus ?? true}
                placeholder={t("commentPlaceholder")}
                className="min-h-[96px] rounded-[6px] border border-accent bg-surface px-3 py-2 shadow-[0_0_0_3px_var(--accent-soft)]"
              />
            </ClientOnly>
            {error && <p className="text-[13px] text-danger">{error}</p>}
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={submit} disabled={submitting || translating || !hasContent}>
                {submitting ? t("savingEllipsis") : t("save")}
              </Button>
              <Button variant="ghost" size="sm" onClick={cancel} disabled={submitting}>
                {t("cancel")}
              </Button>
              <LanguageMenu
                languages={SUPPORTED_LOCALES}
                onPick={translateDraft}
                disabled={!hasContent || submitting || translating}
                className="inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[12.5px] font-medium text-text-2 hover:bg-surface-3 hover:text-text disabled:opacity-60"
              >
                <Languages size={13} />
                {translating ? t("translating") : t("translateDraftTo")}
              </LanguageMenu>
              <span className="ml-auto hidden text-[12px] text-text-3 sm:inline">
                {t("commentTip")} · {t("commentTipHint")}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The emoji chips under a comment, plus the add-reaction picker. Updates the
 * chips at once, then saves. If the save fails the chips roll back and a toast
 * says so. The loader's data replaces the local copy once it refreshes.
 */
function ReactionBar({
  commentId,
  serverReactions,
  usersById,
  currentUserId,
  onToggle,
}: {
  commentId: string;
  serverReactions: ThreadReaction[];
  usersById: UsersById;
  currentUserId?: string;
  onToggle?: (input: ToggleReactionInput) => Promise<void>;
}) {
  const { t } = useTranslation("issue");
  const toast = useToast();
  const [reactions, setReactions] = useState(serverReactions);
  const [pickerOpen, setPickerOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setReactions(serverReactions);
  }, [serverReactions]);

  async function toggle(emoji: string, on: boolean) {
    if (!onToggle || !currentUserId) return;
    const previous = reactions;
    const next = applyReactionToggle(reactions, emoji, on, currentUserId);
    if (next === reactions) return;
    setReactions(next);
    try {
      await onToggle({ commentId, emoji, on });
    } catch {
      setReactions(previous);
      toast.show({ title: t("reactionFailed"), tone: "error" });
    }
  }

  function tooltipFor(reaction: ThreadReaction): string {
    const names = reaction.userIds.map((id) => usersById.get(id)?.name);
    if (names.every((name): name is string => !!name)) return t("reactedBy", { names: names.join(", ") });
    return t("reactedByCount", { count: reaction.count });
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => toggle(r.emoji, !r.reactedByMe)}
          title={tooltipFor(r)}
          aria-label={`${r.emoji} ${r.count}`}
          aria-pressed={r.reactedByMe}
          className={
            r.reactedByMe
              ? "inline-flex h-6 items-center gap-1 rounded-full border border-accent bg-accent-soft px-2 text-[12.5px] text-text"
              : "inline-flex h-6 items-center gap-1 rounded-full border border-border-2 bg-surface px-2 text-[12.5px] text-text-2 hover:bg-surface-3"
          }
        >
          <span className="text-[14px] leading-none">{r.emoji}</span>
          <span className="tabular-nums">{r.count}</span>
        </button>
      ))}
      <button
        ref={addRef}
        type="button"
        onClick={() => setPickerOpen((open) => !open)}
        aria-label={t("addReaction")}
        title={t("addReaction")}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-border-2 bg-surface text-text-3 hover:bg-surface-3 hover:text-text"
      >
        <SmilePlus size={14} />
      </button>
      <Popover open={pickerOpen} onClose={() => setPickerOpen(false)} anchorRef={addRef} width={320} ariaLabel={t("addReaction")}>
        <EmojiPicker
          onClose={() => setPickerOpen(false)}
          onSelect={(emoji) => {
            setPickerOpen(false);
            // Picking an emoji you already reacted with leaves it as it is.
            toggle(emoji, true);
          }}
        />
      </Popover>
    </div>
  );
}

function CommentNode({
  comment,
  childrenByParent,
  usersById,
  intlLocale,
  currentUserId,
  currentUserName,
  onReply,
  onToggleReaction,
}: {
  comment: ThreadComment;
  childrenByParent: Map<string, ThreadComment[]>;
  usersById: UsersById;
  intlLocale: string;
  currentUserId?: string;
  currentUserName?: string;
  onReply: (parentCommentId: string, bodyJson: Block[]) => Promise<void>;
  onToggleReaction?: (input: ToggleReactionInput) => Promise<void>;
}) {
  const { t } = useTranslation("issue");
  const [replying, setReplying] = useState(false);
  const author = usersById.get(comment.authorId);
  const authorName = author?.name ?? t("unknownAuthor");
  const replies = childrenByParent.get(comment.id) ?? [];
  const canReply = comment.depth < 2;

  return (
    <div className="flex gap-3">
      <Avatar name={authorName} size={28} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-[13.5px]">
          <span className="font-semibold text-text">{authorName}</span>
          <span className="text-[12.5px] text-text-3" title={fullDateTime(comment.createdAt, intlLocale)}>
            {relativeTime(comment.createdAt, intlLocale)}
          </span>
        </p>
        <ClientOnly fallback={<p className="mt-1 text-[14px] text-text-2">{blocksToPlainText(comment.bodyJson)}</p>}>
          <TranslatableContent content={comment.bodyJson} className="mt-0.5" />
        </ClientOnly>
        <ReactionBar
          commentId={comment.id}
          serverReactions={comment.reactions}
          usersById={usersById}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
        {canReply && !replying && (
          <button
            type="button"
            onClick={() => setReplying(true)}
            className="mt-1 rounded-[4px] px-1 -ml-1 text-[12.5px] font-medium text-text-2 hover:bg-surface-3 hover:text-text"
          >
            {t("reply")}
          </button>
        )}
        {replying && (
          <div className="mt-2 flex flex-col gap-2">
            <p className="truncate border-l-2 border-border-2 pl-2 text-[12.5px] text-text-3">
              <span className="font-medium text-text-2">{authorName}</span>: {blocksToPlainText(comment.bodyJson).slice(0, 140)}
            </p>
            <CommentComposer
              startExpanded
              authorName={currentUserName}
              onCancel={() => setReplying(false)}
              onSubmit={async (bodyJson) => {
                await onReply(comment.id, bodyJson);
                setReplying(false);
              }}
            />
          </div>
        )}
        {replies.length > 0 && (
          <div className="mt-3 flex flex-col gap-4 border-l-2 border-border pl-4">
            {replies.map((reply) => (
              <CommentNode
                key={reply.id}
                comment={reply}
                childrenByParent={childrenByParent}
                usersById={usersById}
                intlLocale={intlLocale}
                currentUserId={currentUserId}
                currentUserName={currentUserName}
                onReply={onReply}
                onToggleReaction={onToggleReaction}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function CommentThread({
  comments,
  usersById,
  intlLocale,
  currentUserId,
  currentUserName,
  onSubmit,
  onToggleReaction,
  order = "newest",
}: CommentThreadProps) {
  const { t } = useTranslation("issue");
  const childrenByParent = new Map<string, ThreadComment[]>();
  const topLevel: ThreadComment[] = [];
  for (const c of comments) {
    if (c.parentCommentId) {
      const list = childrenByParent.get(c.parentCommentId) ?? [];
      list.push(c);
      childrenByParent.set(c.parentCommentId, list);
    } else {
      topLevel.push(c);
    }
  }
  if (order === "newest") topLevel.reverse();

  async function handleReply(parentCommentId: string, bodyJson: Block[]) {
    await onSubmit({ bodyJson, parentCommentId });
  }

  const composer = <CommentComposer authorName={currentUserName} onSubmit={(bodyJson) => onSubmit({ bodyJson })} />;

  return (
    <div className="flex flex-col gap-5">
      {order === "newest" && composer}
      {comments.length === 0 && <p className="text-[13.5px] text-text-3">{t("noCommentsYet")}</p>}
      {topLevel.map((c) => (
        <CommentNode
          key={c.id}
          comment={c}
          childrenByParent={childrenByParent}
          usersById={usersById}
          intlLocale={intlLocale}
          currentUserId={currentUserId}
          currentUserName={currentUserName}
          onReply={handleReply}
          onToggleReaction={onToggleReaction}
        />
      ))}
      {order === "oldest" && composer}
    </div>
  );
}
