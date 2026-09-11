import { useState } from "react";
import { ClientOnly } from "@tanstack/react-router";
import type { Block } from "@blocknote/core";
import { Avatar } from "@kompast/ui/Avatar";
import { Button } from "@kompast/ui/Button";
import { useTranslation } from "@kompast/i18n";
import { LiteEditor } from "@/components/shared/LiteEditor";
import { RichTextView } from "@/components/shared/RichTextView";

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
  onSubmit: (input: { bodyJson: Block[]; parentCommentId?: string }) => Promise<void>;
}

function initialsOf(name: string) {
  return name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

/**
 * Duplicated from apps/web/src/components/docs/Editor.tsx's own local
 * blockPlainText helper (not imported — it's file-local there too, and
 * packages/core's toPlainText can't be imported into a client bundle: it
 * pulls in the Postgres driver, same "Buffer is not defined" issue
 * apps/web/src/lib/server-fns/issue-properties.ts's own top comment
 * documents for why ISSUE_PROPERTY_TYPES is duplicated rather than
 * imported there). Single-level only (no children recursion) — fine for
 * a short quote excerpt, unlike core's toPlainText which needs full
 * fidelity for RAG indexing.
 */
function blocksToPlainText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      const content = block && typeof block === "object" && Array.isArray((block as { content?: unknown }).content) ? (block as { content: unknown[] }).content : [];
      return content.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: string }).text ?? "") : "")).join("");
    })
    .join("\n")
    .trim();
}

function CommentComposer({
  onSubmit,
  onCancel,
  autoFocus,
}: {
  onSubmit: (bodyJson: Block[]) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation("issue");
  const [draft, setDraft] = useState<Block[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const hasContent = blocksToPlainText(draft).length > 0;

  async function submit() {
    if (!hasContent) return;
    setSubmitting(true);
    try {
      await onSubmit(draft);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <ClientOnly fallback={<div className="min-h-[80px] rounded-[7px] border border-border bg-surface" />}>
        <LiteEditor onChange={setDraft} autoFocus={autoFocus} className="min-h-[80px] rounded-[7px] border border-border bg-surface" />
      </ClientOnly>
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={submit} disabled={submitting || !hasContent}>
          {t("send")}
        </Button>
        {onCancel && (
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            {t("cancel")}
          </Button>
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
  onReply,
}: {
  comment: ThreadComment;
  childrenByParent: Map<string, ThreadComment[]>;
  usersById: Map<string, { id: string; name: string }>;
  intlLocale: string;
  onReply: (parentCommentId: string, bodyJson: Block[]) => Promise<void>;
}) {
  const { t } = useTranslation("issue");
  const [replying, setReplying] = useState(false);
  const author = usersById.get(comment.authorId);
  const replies = childrenByParent.get(comment.id) ?? [];
  const canReply = comment.depth < 2;

  return (
    <div className="flex gap-2.5">
      <Avatar initials={author ? initialsOf(author.name) : "?"} size={24} />
      <div className="min-w-0 flex-1">
        <div className="rounded-[9px] border border-border bg-surface-2 p-3">
          <p className="mb-1 flex items-center gap-2 text-[11.5px]">
            <strong>{author?.name ?? t("unknownAuthor")}</strong>
            <span className="type-label text-text-3">{new Date(comment.createdAt).toLocaleString(intlLocale)}</span>
          </p>
          <ClientOnly>
            <RichTextView content={comment.bodyJson} />
          </ClientOnly>
        </div>
        {canReply && (
          <button onClick={() => setReplying((v) => !v)} className="mt-1 text-[11px] font-medium text-text-3 hover:text-text-2">
            {t("reply")}
          </button>
        )}
        {replying && (
          <div className="mt-2 rounded-[9px] border border-border bg-surface p-2.5">
            <div className="mb-2 border-l-2 border-border-2 pl-2 text-[11px] text-text-3">
              <strong>{author?.name ?? t("unknownAuthor")}</strong>: {blocksToPlainText(comment.bodyJson).slice(0, 140)}
            </div>
            <CommentComposer
              autoFocus
              onCancel={() => setReplying(false)}
              onSubmit={async (bodyJson) => {
                await onReply(comment.id, bodyJson);
                setReplying(false);
              }}
            />
          </div>
        )}
        {replies.length > 0 && (
          <div className="mt-2.5 flex flex-col gap-2.5 border-l-2 border-border pl-3">
            {replies.map((reply) => (
              <CommentNode key={reply.id} comment={reply} childrenByParent={childrenByParent} usersById={usersById} intlLocale={intlLocale} onReply={onReply} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function CommentThread({ comments, usersById, intlLocale, onSubmit }: CommentThreadProps) {
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

  async function handleReply(parentCommentId: string, bodyJson: Block[]) {
    await onSubmit({ bodyJson, parentCommentId });
  }

  return (
    <div className="flex flex-col gap-3">
      {comments.length === 0 && <p className="type-body text-text-3">{t("noCommentsYet")}</p>}
      {topLevel.map((c) => (
        <CommentNode key={c.id} comment={c} childrenByParent={childrenByParent} usersById={usersById} intlLocale={intlLocale} onReply={handleReply} />
      ))}
      <CommentComposer onSubmit={(bodyJson) => onSubmit({ bodyJson })} />
    </div>
  );
}
