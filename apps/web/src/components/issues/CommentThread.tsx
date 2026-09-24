import { useState } from "react";
import { ClientOnly } from "@tanstack/react-router";
import type { Block } from "@blocknote/core";
import { Avatar } from "@kompast/ui/Avatar";
import { Button } from "@kompast/ui/Button";
import { useTranslation } from "@kompast/i18n";
import { LiteEditor } from "@/components/shared/LiteEditor";
import { RichTextView } from "@/components/shared/RichTextView";
import { fullDateTime, relativeTime } from "./time";

export interface ThreadComment {
  id: string;
  authorId: string;
  bodyJson: unknown;
  parentCommentId: string | null;
  depth: number;
  createdAt: string | Date;
}

interface CommentThreadProps {
  comments: ThreadComment[];
  usersById: Map<string, { id: string; name: string }>;
  intlLocale: string;
  currentUserName?: string;
  onSubmit: (input: { bodyJson: Block[]; parentCommentId?: string }) => Promise<void>;
  /** "newest" puts the composer on top and newest comments first (Jira default). */
  order?: "newest" | "oldest";
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
  const hasContent = blocksToPlainText(draft).length > 0 || draft.some((b) => b.type !== "paragraph");

  async function submit() {
    if (!hasContent || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(draft);
      setDraft([]);
      setSubmitCount((c) => c + 1);
      if (!startExpanded) setExpanded(false);
    } catch (err) {
      setError(t("saveFailed", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSubmitting(false);
    }
  }

  function cancel() {
    setDraft([]);
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
                key={submitCount}
                onChange={setDraft}
                autoFocus={autoFocus ?? true}
                placeholder={t("commentPlaceholder")}
                className="min-h-[96px] rounded-[6px] border border-accent bg-surface px-3 py-2 shadow-[0_0_0_3px_var(--accent-soft)]"
              />
            </ClientOnly>
            {error && <p className="text-[13px] text-danger">{error}</p>}
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={submit} disabled={submitting || !hasContent}>
                {submitting ? t("savingEllipsis") : t("save")}
              </Button>
              <Button variant="ghost" size="sm" onClick={cancel} disabled={submitting}>
                {t("cancel")}
              </Button>
              <span className="ml-auto hidden text-[12px] text-text-3 sm:inline">{t("commentTip")}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CommentNode({
  comment,
  childrenByParent,
  usersById,
  intlLocale,
  currentUserName,
  onReply,
}: {
  comment: ThreadComment;
  childrenByParent: Map<string, ThreadComment[]>;
  usersById: Map<string, { id: string; name: string }>;
  intlLocale: string;
  currentUserName?: string;
  onReply: (parentCommentId: string, bodyJson: Block[]) => Promise<void>;
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
          <RichTextView content={comment.bodyJson} className="mt-0.5" />
        </ClientOnly>
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
                currentUserName={currentUserName}
                onReply={onReply}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function CommentThread({ comments, usersById, intlLocale, currentUserName, onSubmit, order = "newest" }: CommentThreadProps) {
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
          currentUserName={currentUserName}
          onReply={handleReply}
        />
      ))}
      {order === "oldest" && composer}
    </div>
  );
}
