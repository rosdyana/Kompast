import { useEffect, useState } from "react";
import { ClientOnly, Link, useLoaderData } from "@tanstack/react-router";
import { ExternalLink, FileText, MessageSquare, Ticket, X } from "lucide-react";
import { IconButton } from "@kompast/ui/Button";
import { Avatar, UnassignedAvatar } from "@kompast/ui/Avatar";
import { StatusDot } from "@kompast/ui/Lozenge";
import { PriorityIcon, type PriorityLike } from "@kompast/ui/PriorityIcon";
import { SkeletonRows } from "@kompast/ui/EmptyState";
import { useTranslation } from "@kompast/i18n";
import type { AskCitation } from "@/lib/ask-stream-client";
import { getIssueDetailFn } from "@/lib/server-fns/issue-detail";
import { getPageEditorAccessFn } from "@/lib/server-fns/pages";
import { DocEditor } from "@/components/docs/Editor";
import { RichTextView, normalizeToBlocks } from "@/components/shared/RichTextView";

type IssueDetail = Awaited<ReturnType<typeof getIssueDetailFn>>;
type PageAccess = Awaited<ReturnType<typeof getPageEditorAccessFn>>;

type LoadState<T> = { status: "loading" } | { status: "error" } | { status: "ready"; data: T };

/** Read-only view of a cited issue: fields, description, and the latest comments. Editing stays on the issue page. */
function IssueSource({ detail }: { detail: IssueDetail }) {
  const { t } = useTranslation("ask");
  const { project, issue, status, type, users, comments, priorityLevels } = detail;
  const priority: PriorityLike | undefined = priorityLevels.find((p) => p.key === issue.priority);
  const assignee = users.find((u) => u.id === issue.assigneeId);
  const recentComments = comments.slice(-3);
  const usersById = new Map(users.map((u) => [u.id, u]));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="font-mono text-[12px] text-text-3">{`${project.key}-${issue.keySeq}`}</p>
        <h2 className="mt-1 text-[17px] font-semibold leading-snug text-text">{issue.title}</h2>
      </div>

      <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2.5 text-[13.5px]">
        <dt className="text-text-3">{t("statusLabel")}</dt>
        <dd>
          {status ? (
            <span className="inline-flex items-center gap-1.5 text-text-2">
              <StatusDot color={status.color} />
              {status.name}
            </span>
          ) : (
            <span className="text-text-2">—</span>
          )}
        </dd>

        <dt className="text-text-3">{t("typeLabel")}</dt>
        <dd className="text-text-2">{type?.name ?? "—"}</dd>

        <dt className="text-text-3">{t("priorityLabel")}</dt>
        <dd className="flex items-center gap-1.5 text-text-2">
          {priority && <PriorityIcon priority={priority} size={14} />}
          <span>{priority?.name ?? issue.priority}</span>
        </dd>

        <dt className="text-text-3">{t("assigneeLabel")}</dt>
        <dd className="flex items-center gap-2 text-text-2">
          {assignee ? (
            <>
              <Avatar name={assignee.name} size={20} />
              <span>{assignee.name}</span>
            </>
          ) : (
            <>
              <UnassignedAvatar size={20} />
              <span>{t("unassigned")}</span>
            </>
          )}
        </dd>
      </dl>

      {normalizeToBlocks(issue.descriptionJson) && (
        <section>
          <h3 className="mb-1.5 text-[12px] font-semibold text-text-3">{t("descriptionLabel")}</h3>
          <RichTextView content={issue.descriptionJson} className="text-[14px] text-text" />
        </section>
      )}

      {recentComments.length > 0 && (
        <section>
          <h3 className="mb-2 text-[12px] font-semibold text-text-3">{t("commentsLabel")}</h3>
          <div className="flex flex-col gap-3">
            {recentComments.map((c) => {
              const author = c.authorId ? usersById.get(c.authorId) : undefined;
              return (
                <div key={c.id} className="rounded-[8px] border border-border bg-surface p-3">
                  <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-medium text-text-2">
                    {author && <Avatar name={author.name} size={18} />}
                    <span>{author?.name ?? "—"}</span>
                  </div>
                  <RichTextView content={c.bodyJson} className="text-[13.5px] text-text" />
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

/** Read-only page body, rendered with the same editor the page itself uses (so mentions, views and diagrams display). */
function PageSource({ access }: { access: PageAccess }) {
  const shell = useLoaderData({ from: "/_app" });
  return (
    <ClientOnly fallback={<div className="min-h-[40vh]" />}>
      <DocEditor
        pageId={access.page.id}
        collabToken={access.collabToken}
        collabWsUrl={access.collabWsUrl}
        canEdit={false}
        userId={shell.user.id}
        userName={shell.user.name}
      />
    </ClientOnly>
  );
}

/**
 * Right-hand preview of a cited source. Fetches the entity on open (issue detail or page editor access), keyed on the
 * citation's ref so a stale response for a previous source is ignored. The parent owns when it is shown and closed.
 */
export function SourcePanel({ citation, onClose }: { citation: AskCitation; onClose: () => void }) {
  const { t } = useTranslation("ask");
  const ref = citation.ref;
  const refKey = ref ? (ref.kind === "issue" ? `issue:${ref.teamId ?? "none"}:${ref.projectKey}:${ref.keySeq}` : `page:${ref.pageId}`) : "none";
  const [issueState, setIssueState] = useState<LoadState<IssueDetail>>({ status: "loading" });
  const [pageState, setPageState] = useState<LoadState<PageAccess>>({ status: "loading" });

  useEffect(() => {
    if (!ref || ref.kind !== "issue") return;
    let cancelled = false;
    setIssueState({ status: "loading" });
    getIssueDetailFn({ data: { teamId: ref.teamId ?? "none", projectKey: ref.projectKey, issueKeySeq: ref.keySeq } })
      .then((data) => {
        if (!cancelled) setIssueState({ status: "ready", data });
      })
      .catch(() => {
        if (!cancelled) setIssueState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [refKey]);

  useEffect(() => {
    if (!ref || ref.kind !== "page") return;
    let cancelled = false;
    setPageState({ status: "loading" });
    getPageEditorAccessFn({ data: ref.pageId })
      .then((data) => {
        if (!cancelled) setPageState({ status: "ready", data });
      })
      .catch(() => {
        if (!cancelled) setPageState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [refKey]);

  const Icon = citation.entityType === "page" ? FileText : citation.entityType === "comment" ? MessageSquare : Ticket;
  const typeLabel = citation.entityType === "page" ? t("sourcePage") : citation.entityType === "comment" ? t("sourceComment") : t("sourceIssue");
  const fullRoute =
    ref?.kind === "issue" ? (
      <Link
        to="/issues/$teamId/$projectKey/$issueKeySeq"
        params={{ teamId: ref.teamId ?? "none", projectKey: ref.projectKey, issueKeySeq: String(ref.keySeq) }}
        title={t("openSource")}
        aria-label={t("openSource")}
        className="grid h-7 w-7 flex-none place-items-center rounded-[6px] text-text-2 hover:bg-surface-3 hover:text-text"
      >
        <ExternalLink size={15} strokeWidth={1.75} />
      </Link>
    ) : ref?.kind === "page" ? (
      <Link
        to="/docs/$pageId"
        params={{ pageId: ref.pageId }}
        title={t("openSource")}
        aria-label={t("openSource")}
        className="grid h-7 w-7 flex-none place-items-center rounded-[6px] text-text-2 hover:bg-surface-3 hover:text-text"
      >
        <ExternalLink size={15} strokeWidth={1.75} />
      </Link>
    ) : null;

  return (
    <aside className="fixed inset-y-11 right-0 z-30 flex w-full flex-col border-l border-border bg-surface md:static md:inset-auto md:w-[420px] md:flex-none">
      <header className="flex flex-none items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon size={14} className="flex-none text-text-3" />
        <span className="flex-none text-[12.5px] font-medium text-text-3">{typeLabel}</span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text">{citation.title || citation.excerpt}</span>
        {fullRoute}
        <IconButton aria-label={t("closePreview")} title={t("closePreview")} onClick={onClose}>
          <X size={16} strokeWidth={1.75} />
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-5">
          <p className="mb-1.5 text-[12px] font-medium text-text-3">{t("citedExcerpt")}</p>
          <p className="whitespace-pre-wrap rounded-[8px] bg-surface-2 p-3 text-[13px] leading-relaxed text-text-2">{citation.excerpt}</p>
        </div>

        {ref?.kind === "issue" &&
          (issueState.status === "loading" ? (
            <SkeletonRows rows={5} />
          ) : issueState.status === "error" ? (
            <p className="text-[13.5px] text-text-3">{t("sourceUnavailable")}</p>
          ) : (
            <IssueSource detail={issueState.data} />
          ))}

        {ref?.kind === "page" &&
          (pageState.status === "loading" ? (
            <SkeletonRows rows={5} />
          ) : pageState.status === "error" ? (
            <p className="text-[13.5px] text-text-3">{t("sourceUnavailable")}</p>
          ) : (
            <PageSource access={pageState.data} />
          ))}
      </div>
    </aside>
  );
}
