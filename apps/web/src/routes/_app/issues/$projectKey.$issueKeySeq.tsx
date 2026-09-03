import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Badge } from "@kompast/ui/Badge";
import { Avatar } from "@kompast/ui/Avatar";
import { Button } from "@kompast/ui/Button";
import { getIssueDetailFn, addCommentFn, toggleWatchFn } from "@/lib/server-fns/issue-detail";

export const Route = createFileRoute("/_app/issues/$projectKey/$issueKeySeq")({
  loader: ({ params }) =>
    getIssueDetailFn({ data: { projectKey: params.projectKey, issueKeySeq: Number(params.issueKeySeq) } }),
  component: IssueDetailPage,
});

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function IssueDetailPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [watching, setWatching] = useState(data.isWatching);

  const usersById = new Map(data.users.map((u) => [u.id, u]));

  async function submitComment() {
    if (!comment.trim()) return;
    setSubmitting(true);
    try {
      await addCommentFn({ data: { issueId: data.issue.id, text: comment.trim() } });
      setComment("");
      await router.invalidate();
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleWatch() {
    const next = !watching;
    setWatching(next);
    await toggleWatchFn({ data: { issueId: data.issue.id, watching: next } });
  }

  return (
    <div className="mx-auto max-w-[820px] px-8 pb-16 pt-9">
      <Link
        to="/projects/$projectKey"
        params={{ projectKey: data.project.key }}
        className="mb-4 inline-block text-xs text-text-3 hover:text-text-2"
      >
        ← {data.project.name}
      </Link>

      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono text-[12px] text-text-3">
          {data.project.key}-{data.issue.keySeq}
        </span>
        {data.type && <Badge tone="indigo">{data.type.name}</Badge>}
        {data.status && <Badge tone="green">{data.status.name}</Badge>}
      </div>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">{data.issue.title}</h1>

      <div className="mb-8 flex flex-wrap gap-4 rounded-xl border border-border bg-surface p-4 text-[12.5px]">
        <div>
          <p className="mb-1 text-text-3">Assignee</p>
          {data.issue.assigneeId && usersById.get(data.issue.assigneeId) ? (
            <div className="flex items-center gap-1.5">
              <Avatar initials={initialsOf(usersById.get(data.issue.assigneeId)!.name)} size={18} />
              {usersById.get(data.issue.assigneeId)!.name}
            </div>
          ) : (
            <span className="text-text-3">Belum ditugaskan</span>
          )}
        </div>
        <div>
          <p className="mb-1 text-text-3">Reporter</p>
          {usersById.get(data.issue.reporterId)?.name ?? "—"}
        </div>
        <div>
          <p className="mb-1 text-text-3">Priority</p>
          {data.issue.priority}
        </div>
        {data.issue.storyPoints != null && (
          <div>
            <p className="mb-1 text-text-3">Points</p>
            {data.issue.storyPoints}
          </div>
        )}
        <div className="ml-auto">
          <Button variant={watching ? "primary" : "outline"} onClick={toggleWatch} className="text-[12px]">
            {watching ? "◔ Mengawasi" : "◔ Awasi"}
          </Button>
        </div>
      </div>

      <section className="mb-8">
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
          <Button variant="primary" onClick={submitComment} disabled={submitting || !comment.trim()}>
            Kirim
          </Button>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-[13px] font-semibold">Aktivitas</h2>
        <div className="flex flex-col gap-2">
          {data.history.length === 0 && <p className="text-sm text-text-3">Belum ada aktivitas.</p>}
          {data.history.map((h) => (
            <p key={h.id} className="text-[12px] text-text-2">
              <span className="font-mono text-text-3">{new Date(h.createdAt).toLocaleString("id-ID")}</span>{" "}
              {h.field === "created" ? "dibuat" : `${h.field}: ${h.fromValue ?? "—"} → ${h.toValue ?? "—"}`}
              {h.origin !== "user" && <span className="ml-1 text-text-3">via {h.originClient ?? h.origin}</span>}
            </p>
          ))}
        </div>
      </section>
    </div>
  );
}
