import { createFileRoute, ClientOnly, Link, useRouter, useLoaderData } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { Avatar } from "@kompast/ui/Avatar";
import {
  getPageDetailFn,
  updatePageMetaFn,
  createPageFn,
  archivePageFn,
  toggleFavoritePageFn,
  addPageCommentFn,
  unlinkPageFromIssueFn,
  createShareLinkFn,
  revokeShareLinkFn,
} from "@/lib/server-fns/pages";
import { DocEditor } from "@/components/docs/Editor";

export const Route = createFileRoute("/_app/docs/$pageId")({
  loader: ({ params }) => getPageDetailFn({ data: params.pageId }),
  component: DocPage,
});

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function DocPage() {
  const data = Route.useLoaderData();
  const shell = useLoaderData({ from: "/_app" });
  const router = useRouter();
  const [title, setTitle] = useState(data.page.title);
  const [comment, setComment] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const [favorited, setFavorited] = useState(data.isFavorited);
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

  const projectsById = new Map(data.linkedProjects.map((p) => [p.id, p]));

  return (
    <div className="mx-auto max-w-[820px] px-8 pb-16 pt-9">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-2xl">{data.page.icon || "▤"}</span>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" className="text-[12px]" onClick={toggleFavorite}>
            {favorited ? "★ Favorit" : "☆ Favorit"}
          </Button>
          <Button variant="outline" className="text-[12px]" onClick={() => setShareOpen((s) => !s)}>
            🔗 Bagikan
          </Button>
          {data.canEdit && (
            <Button variant="outline" className="text-[12px]" onClick={archive}>
              Arsipkan
            </Button>
          )}
        </div>
      </div>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        placeholder="Tanpa judul"
        disabled={!data.canEdit}
        className="mb-6 w-full border-none bg-transparent text-3xl font-semibold tracking-tight outline-none placeholder:text-text-3"
      />

      {shareOpen && (
        <div className="mb-6 rounded-xl border border-border bg-surface p-4 text-[12.5px]">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold">Tautan berbagi</h3>
            <Button variant="primary" className="text-[12px]" onClick={createShare}>
              + Buat tautan
            </Button>
          </div>
          {data.shareLinks.length === 0 ? (
            <p className="text-text-3">Belum ada tautan berbagi. Halaman ini hanya bisa dilihat anggota workspace.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {data.shareLinks.map((link) => (
                <div key={link.id} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
                  <span className="text-text-3">{link.scope === "view" ? "Lihat saja" : "Bisa komentar"}</span>
                  {link.hasPassword && <span className="text-text-3">· dengan kata sandi</span>}
                  {link.revokedAt ? (
                    <span className="text-accent">· dicabut</span>
                  ) : (
                    <button onClick={() => revokeShare(link.id)} className="ml-auto text-text-3 hover:text-accent">
                      Cabut
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

      {data.children.length > 0 && (
        <section className="mb-8 mt-8">
          <h2 className="mb-3 text-[13px] font-semibold">Sub-halaman</h2>
          <div className="flex flex-col gap-1.5">
            {data.children.map((child) => (
              <Link
                key={child.id}
                to="/docs/$pageId"
                params={{ pageId: child.id }}
                className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[13px] hover:border-border-2"
              >
                <span>{child.icon || "▤"}</span>
                {child.title || "Tanpa judul"}
              </Link>
            ))}
          </div>
        </section>
      )}

      {data.canEdit && (
        <div className="mb-8">
          <Button variant="outline" className="text-[12px]" onClick={addChildPage} disabled={addingChild}>
            + Sub-halaman
          </Button>
        </div>
      )}

      {data.linkedIssues.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-[13px] font-semibold">Tiket tertaut</h2>
          <div className="flex flex-col gap-1.5">
            {data.linkedIssues.map((issue) => {
              const project = projectsById.get(issue.projectId);
              return (
                <div key={issue.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[13px]">
                  {project ? (
                    <Link
                      to="/issues/$projectKey/$issueKeySeq"
                      params={{ projectKey: project.key, issueKeySeq: String(issue.keySeq) }}
                      className="font-mono text-text-3 hover:text-accent"
                    >
                      {project.key}-{issue.keySeq}
                    </Link>
                  ) : (
                    <span className="font-mono text-text-3">#{issue.keySeq}</span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                  <button onClick={() => unlinkIssue(issue.id)} className="text-text-3 hover:text-accent">
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {data.backlinkPages.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-[13px] font-semibold">Disebutkan di</h2>
          <div className="flex flex-col gap-1.5">
            {data.backlinkPages.map((p) => (
              <Link
                key={p.id}
                to="/docs/$pageId"
                params={{ pageId: p.id }}
                className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[13px] hover:border-border-2"
              >
                <span>{p.icon || "▤"}</span>
                {p.title || "Tanpa judul"}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-[13px] font-semibold">Komentar</h2>
        <div className="mb-3 flex flex-col gap-3">
          {data.comments.length === 0 && <p className="text-sm text-text-3">Belum ada komentar.</p>}
          {data.comments.map((c) => {
            const author = usersById.get(c.authorId);
            const body = c.bodyJson as { text?: string } | null;
            return (
              <div key={c.id} className="flex gap-2.5">
                <Avatar initials={author ? initialsOf(author.name) : "?"} size={24} />
                <div className="min-w-0 flex-1 rounded-lg border border-border bg-surface p-2.5">
                  <p className="mb-1 flex items-center gap-2 text-[11.5px]">
                    <strong>{author?.name ?? "Unknown"}</strong>
                    <span className="text-text-3">{new Date(c.createdAt).toLocaleString("id-ID")}</span>
                  </p>
                  <p className="text-[13px] leading-snug">{body?.text ?? ""}</p>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex gap-2">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Tulis komentar…"
            rows={2}
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface p-2.5 text-[13px] outline-none focus:border-border-2"
          />
          <Button variant="primary" onClick={submitComment} disabled={!comment.trim()}>
            Kirim
          </Button>
        </div>
      </section>
    </div>
  );
}
