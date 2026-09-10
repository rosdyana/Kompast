import { createFileRoute, ClientOnly, Link, useRouter, useLoaderData } from "@tanstack/react-router";
import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { Avatar } from "@kompast/ui/Avatar";
import { PageContainer } from "@kompast/ui/PageContainer";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import {
  getPageDetailFn,
  updatePageMetaFn,
  createPageFn,
  archivePageFn,
  toggleFavoritePageFn,
  addPageCommentFn,
  linkPageToIssueFn,
  unlinkPageFromIssueFn,
  createShareLinkFn,
  revokeShareLinkFn,
  setPageTemplateFn,
} from "@/lib/server-fns/pages";
import { resolveIssueByKeyFn } from "@/lib/server-fns/issue-detail";
import { DocEditor } from "@/components/docs/Editor";

export const Route = createFileRoute("/_app/docs/$pageId")({
  loader: ({ params }) => getPageDetailFn({ data: params.pageId }),
  component: DocPage,
});

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function DocPage() {
  const { t, i18n } = useTranslation("docs");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const data = Route.useLoaderData();
  const shell = useLoaderData({ from: "/_app" });
  const router = useRouter();
  const [title, setTitle] = useState(data.page.title);
  const [comment, setComment] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const [favorited, setFavorited] = useState(data.isFavorited);
  const [isTemplate, setIsTemplate] = useState(data.page.type === "template");
  const [issueKeyInput, setIssueKeyInput] = useState("");
  const [linkingIssue, setLinkingIssue] = useState(false);
  const [linkIssueError, setLinkIssueError] = useState("");
  const usersById = new Map(data.users.map((u) => [u.id, u]));

  async function saveTitle() {
    if (title === data.page.title) return;
    await updatePageMetaFn({ data: { pageId: data.page.id, title } });
    await router.invalidate();
  }

  async function addChildPage() {
    setAddingChild(true);
    try {
      const page = await createPageFn({ data: { parentPageId: data.page.id } });
      await router.navigate({ to: "/docs/$pageId", params: { pageId: page.id } });
    } finally {
      setAddingChild(false);
    }
  }

  async function toggleFavorite() {
    const res = await toggleFavoritePageFn({ data: data.page.id });
    setFavorited(res.favorited);
  }

  async function archive() {
    await archivePageFn({ data: data.page.id });
    await router.navigate({ to: "/docs" });
  }

  async function toggleTemplate() {
    const next = !isTemplate;
    setIsTemplate(next);
    await setPageTemplateFn({ data: { pageId: data.page.id, isTemplate: next } });
  }

  async function submitComment() {
    if (!comment.trim()) return;
    await addPageCommentFn({ data: { pageId: data.page.id, blockId: "page", text: comment.trim() } });
    setComment("");
    await router.invalidate();
  }

  async function createShare() {
    await createShareLinkFn({ data: { pageId: data.page.id } });
    await router.invalidate();
  }

  async function revokeShare(id: string) {
    await revokeShareLinkFn({ data: id });
    await router.invalidate();
  }

  async function unlinkIssue(issueId: string) {
    await unlinkPageFromIssueFn({ data: { pageId: data.page.id, issueId } });
    await router.invalidate();
  }

  async function linkIssue() {
    const match = /^([a-zA-Z]+)-(\d+)$/.exec(issueKeyInput.trim());
    if (!match) {
      setLinkIssueError(t("pageDetail.linkIssueFormatError"));
      return;
    }
    setLinkingIssue(true);
    setLinkIssueError("");
    try {
      const { issueId } = await resolveIssueByKeyFn({ data: issueKeyInput.trim() });
      await linkPageToIssueFn({ data: { pageId: data.page.id, issueId } });
      setIssueKeyInput("");
      await router.invalidate();
    } catch {
      setLinkIssueError(t("pageDetail.linkIssueNotFound"));
    } finally {
      setLinkingIssue(false);
    }
  }

  const projectsById = new Map(data.linkedProjects.map((p) => [p.id, p]));

  return (
    <PageContainer width="reading">
      <div className="sticky top-0 z-10 -mx-8 mb-6 bg-bg px-8 pb-3 pt-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-2xl">{data.page.icon || "▭"}</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            placeholder={t("untitled")}
            disabled={!data.canEdit}
            className="min-w-0 flex-1 border-none bg-transparent type-title outline-none placeholder:text-text-3"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="outline" onClick={toggleFavorite}>
            {favorited ? t("pageDetail.favoriteOn") : t("pageDetail.favoriteOff")}
          </Button>
          <Button variant="outline" onClick={() => setShareOpen((s) => !s)}>
            {t("pageDetail.share")}
          </Button>
          {data.canEdit && (
            <Button variant={isTemplate ? "primary" : "outline"} onClick={toggleTemplate}>
              {isTemplate ? t("pageDetail.templateBadge") : t("pageDetail.makeTemplate")}
            </Button>
          )}
          {data.canEdit && (
            <Button variant="outline" onClick={archive}>
              {t("pageDetail.archive")}
            </Button>
          )}
        </div>
      </div>

      {shareOpen && (
        <div className="mb-6 rounded-xl border border-border bg-surface p-4 type-body">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold">{t("pageDetail.shareLinkHeading")}</h3>
            <Button variant="primary" onClick={createShare}>
              {t("pageDetail.newLink")}
            </Button>
          </div>
          {data.shareLinks.length === 0 ? (
            <p className="text-text-3">{t("pageDetail.noShareLinksYet")}</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {data.shareLinks.map((link) => (
                <div key={link.id} className="flex items-center gap-2 rounded-[9px] border border-border px-2.5 py-1.5">
                  <span className="text-text-3">{link.scope === "view" ? t("pageDetail.viewOnly") : t("pageDetail.canComment")}</span>
                  {link.hasPassword && <span className="text-text-3">{t("pageDetail.withPassword")}</span>}
                  {link.revokedAt ? (
                    <span className="text-danger">{t("pageDetail.revoked")}</span>
                  ) : (
                    <button onClick={() => revokeShare(link.id)} className="ml-auto text-text-3 hover:text-danger">
                      {t("pageDetail.revokeLink")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <ClientOnly fallback={<div className="min-h-[40vh] rounded-xl border border-border bg-surface" />}>
        <DocEditor
          pageId={data.page.id}
          collabToken={data.collabToken}
          collabWsUrl={data.collabWsUrl}
          canEdit={data.canEdit}
          userId={shell.user.id}
          userName={shell.user.name}
        />
      </ClientOnly>

      <div className="mt-8 divide-y divide-border rounded-xl border border-border bg-surface">
        {data.children.length > 0 && (
          <section className="p-4">
            <h2 className="mb-3 type-headline">{t("pageDetail.subPagesHeading")}</h2>
            <div className="flex flex-col gap-1.5">
              {data.children.map((child) => (
                <Link
                  key={child.id}
                  to="/docs/$pageId"
                  params={{ pageId: child.id }}
                  className="flex items-center gap-2 rounded-[9px] border border-border bg-surface-2 px-3 py-2 type-body hover:border-border-2"
                >
                  <span>{child.icon || "▭"}</span>
                  {child.title || t("untitled")}
                </Link>
              ))}
            </div>
          </section>
        )}

        {data.canEdit && (
          <section className="p-4">
            <Button variant="outline" onClick={addChildPage} disabled={addingChild}>
              {t("pageDetail.addSubPage")}
            </Button>
          </section>
        )}

        {data.canEdit && (
          <section className="p-4">
            <h2 className="mb-3 type-headline">{t("pageDetail.linkedIssuesHeading")}</h2>
            {data.linkedIssues.length > 0 && (
              <div className="mb-2 flex flex-col gap-1.5">
                {data.linkedIssues.map((issue) => {
                  const project = projectsById.get(issue.projectId);
                  return (
                    <div key={issue.id} className="flex items-center gap-2 rounded-[9px] border border-border bg-surface-2 px-3 py-2 type-body">
                      {project ? (
                        <Link
                          to="/issues/$teamId/$projectKey/$issueKeySeq"
                          params={{ teamId: project.teamId ?? "none", projectKey: project.key, issueKeySeq: String(issue.keySeq) }}
                          className="font-mono text-text-3 hover:text-accent"
                        >
                          {project.key}-{issue.keySeq}
                        </Link>
                      ) : (
                        <span className="font-mono text-text-3">#{issue.keySeq}</span>
                      )}
                      <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                      <button onClick={() => unlinkIssue(issue.id)} className="text-text-3 hover:text-danger">
                        <X size={13} strokeWidth={1.75} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <input
                value={issueKeyInput}
                onChange={(e) => setIssueKeyInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && linkIssue()}
                placeholder="KPT-12"
                className="w-[140px] rounded-[7px] border border-border bg-surface px-2.5 py-1.5 font-mono text-[12.5px] outline-none focus:border-border-2"
              />
              <Button variant="outline" onClick={linkIssue} disabled={linkingIssue || !issueKeyInput.trim()}>
                {t("pageDetail.linkIssueButton")}
              </Button>
              {linkIssueError && <span className="self-center type-body text-danger">{linkIssueError}</span>}
            </div>
          </section>
        )}

        {data.backlinkPages.length > 0 && (
          <section className="p-4">
            <h2 className="mb-3 type-headline">{t("pageDetail.mentionedInHeading")}</h2>
            <div className="flex flex-col gap-1.5">
              {data.backlinkPages.map((p) => (
                <Link
                  key={p.id}
                  to="/docs/$pageId"
                  params={{ pageId: p.id }}
                  className="flex items-center gap-2 rounded-[9px] border border-border bg-surface-2 px-3 py-2 type-body hover:border-border-2"
                >
                  <span>{p.icon || "▭"}</span>
                  {p.title || t("untitled")}
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="p-4">
          <h2 className="mb-3 type-headline">{t("pageDetail.commentsHeading")}</h2>
          <div className="mb-3 flex flex-col gap-3">
            {data.comments.length === 0 && <p className="type-body text-text-3">{t("pageDetail.noCommentsYet")}</p>}
            {data.comments.map((c) => {
              const author = usersById.get(c.authorId);
              const body = c.bodyJson as { text?: string } | null;
              return (
                <div key={c.id} className="flex gap-2.5">
                  <Avatar initials={author ? initialsOf(author.name) : "?"} size={24} />
                  <div className="min-w-0 flex-1 rounded-[9px] border border-border bg-surface-2 p-3">
                    <p className="mb-1 flex items-center gap-2 text-[11.5px]">
                      <strong>{author?.name ?? t("versionHistory.unknownAuthor")}</strong>
                      <span className="type-label text-text-3">{new Date(c.createdAt).toLocaleString(intlLocale)}</span>
                    </p>
                    <p className="type-body leading-snug">{body?.text ?? ""}</p>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex gap-2">
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t("pageDetail.commentPlaceholder")}
              rows={2}
              className="min-w-0 flex-1 rounded-[7px] border border-border bg-surface p-3 text-[12.5px] outline-none focus:border-border-2"
            />
            <Button variant="primary" onClick={submitComment} disabled={!comment.trim()}>
              {t("send")}
            </Button>
          </div>
        </section>
      </div>
    </PageContainer>
  );
}
