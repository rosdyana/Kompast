import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Badge } from "@kompast/ui/Badge";
import { Avatar } from "@kompast/ui/Avatar";
import { Button } from "@kompast/ui/Button";
import {
  getIssueDetailFn,
  addCommentFn,
  toggleWatchFn,
  updateIssueDescriptionFn,
  updateIssueAssigneeFn,
  updateIssuePriorityFn,
  updateIssueCustomFieldFn,
} from "@/lib/server-fns/issue-detail";
import { requestAttachmentUploadFn, deleteAttachmentFn } from "@/lib/server-fns/attachments";
import { streamAiCompletion } from "@/lib/ai-stream-client";

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
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const initialDescription = (data.issue.descriptionJson as { text?: string } | null)?.text ?? "";
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState(initialDescription);
  const [savingDescription, setSavingDescription] = useState(false);
  const [aiDraftBusy, setAiDraftBusy] = useState(false);

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

  async function setAssignee(assigneeId: string) {
    await updateIssueAssigneeFn({ data: { issueId: data.issue.id, assigneeId: assigneeId || null } });
    await router.invalidate();
  }

  async function setPriority(priority: string) {
    await updateIssuePriorityFn({ data: { issueId: data.issue.id, priority: priority as typeof data.issue.priority } });
    await router.invalidate();
  }

  async function setCustomField(key: string, value: string | number | boolean | string[] | null) {
    await updateIssueCustomFieldFn({ data: { issueId: data.issue.id, key, value } });
    await router.invalidate();
  }

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const { uploadUrl, headers } = await requestAttachmentUploadFn({
        data: {
          issueId: data.issue.id,
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        },
      });
      const res = await fetch(uploadUrl, { method: "PUT", headers, body: file });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      await router.invalidate();
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function removeAttachment(attachmentId: string) {
    await deleteAttachmentFn({ data: { attachmentId, issueId: data.issue.id } });
    await router.invalidate();
  }

  async function saveDescription() {
    setSavingDescription(true);
    try {
      await updateIssueDescriptionFn({ data: { issueId: data.issue.id, description: descriptionDraft } });
      setEditingDescription(false);
      await router.invalidate();
    } finally {
      setSavingDescription(false);
    }
  }

  async function generateAiDescriptionDraft() {
    setAiDraftBusy(true);
    setDescriptionDraft("");
    try {
      await streamAiCompletion({ feature: "issue-description", title: data.issue.title }, (delta) => {
        setDescriptionDraft((prev) => prev + delta);
      });
    } catch (err) {
      setDescriptionDraft(err instanceof Error ? `(AI gagal: ${err.message})` : "(AI gagal)");
    } finally {
      setAiDraftBusy(false);
    }
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
          <select
            value={data.issue.assigneeId ?? ""}
            onChange={(e) => setAssignee(e.target.value)}
            className="rounded-md border border-border-2 bg-surface px-2 py-1 text-[12.5px] outline-none"
          >
            <option value="">Belum ditugaskan</option>
            {data.orgMembers.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <p className="mb-1 text-text-3">Reporter</p>
          {usersById.get(data.issue.reporterId)?.name ?? "—"}
        </div>
        <div>
          <p className="mb-1 text-text-3">Priority</p>
          <select
            value={data.issue.priority}
            onChange={(e) => setPriority(e.target.value)}
            className="rounded-md border border-border-2 bg-surface px-2 py-1 text-[12.5px] outline-none"
          >
            {["lowest", "low", "medium", "high", "highest"].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
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

      {data.propertyDefinitions.length > 0 && (
        <CustomPropertiesSection
          definitions={data.propertyDefinitions}
          customFields={(data.issue.customFields ?? {}) as Record<string, unknown>}
          onChange={setCustomField}
        />
      )}

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold">Deskripsi</h2>
          {!editingDescription && (
            <Button
              variant="outline"
              className="text-[12px]"
              onClick={() => {
                setDescriptionDraft(initialDescription);
                setEditingDescription(true);
              }}
            >
              {initialDescription ? "Edit" : "+ Tambah deskripsi"}
            </Button>
          )}
        </div>
        {editingDescription ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={descriptionDraft}
              onChange={(e) => setDescriptionDraft(e.target.value)}
              rows={6}
              placeholder="Tulis deskripsi (Markdown didukung)…"
              className="w-full rounded-lg border border-border bg-surface p-2.5 text-[13px] outline-none focus:border-border-2"
            />
            <div className="flex items-center gap-2">
              <Button variant="primary" className="text-[12px]" onClick={saveDescription} disabled={savingDescription}>
                {savingDescription ? "Menyimpan…" : "Simpan"}
              </Button>
              <Button variant="outline" className="text-[12px]" onClick={() => setEditingDescription(false)} disabled={savingDescription}>
                Batal
              </Button>
              <Button variant="outline" className="text-[12px]" onClick={generateAiDescriptionDraft} disabled={aiDraftBusy}>
                {aiDraftBusy ? "AI menulis…" : "✨ Buat draft dengan AI"}
              </Button>
            </div>
          </div>
        ) : initialDescription ? (
          <p className="whitespace-pre-wrap text-[13px] leading-snug text-text-2">{initialDescription}</p>
        ) : (
          <p className="text-sm text-text-3">Belum ada deskripsi.</p>
        )}
      </section>

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold">Lampiran</h2>
          <Button variant="outline" className="text-[12px]" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? "Mengunggah…" : "+ Lampirkan file"}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadFile(file);
            }}
          />
        </div>
        {data.attachments.length === 0 ? (
          <p className="text-sm text-text-3">Belum ada lampiran.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {data.attachments.map((a) => (
              <div key={a.id} className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2">
                <span className="text-[13px]">▤</span>
                <a
                  href={a.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-[13px] text-accent hover:underline"
                >
                  {a.fileName}
                </a>
                <span className="font-mono text-[10.5px] text-text-3">{(a.sizeBytes / 1024).toFixed(0)} KB</span>
                <button
                  onClick={() => removeAttachment(a.id)}
                  className="rounded px-1 py-0.5 text-[11px] text-text-3 hover:bg-danger-soft hover:text-danger"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

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

type PropertyDefinition = Awaited<ReturnType<typeof getIssueDetailFn>>["propertyDefinitions"][number];

function CustomPropertiesSection({
  definitions,
  customFields,
  onChange,
}: {
  definitions: PropertyDefinition[];
  customFields: Record<string, unknown>;
  onChange: (key: string, value: string | number | boolean | string[] | null) => void;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-[13px] font-semibold">Properti kustom</h2>
      <div className="flex flex-wrap gap-4 rounded-xl border border-border bg-surface p-4 text-[12.5px]">
        {definitions.map((def) => (
          <CustomPropertyField key={def.id} def={def} value={customFields[def.key]} onChange={(v) => onChange(def.key, v)} />
        ))}
      </div>
    </section>
  );
}

function CustomPropertyField({
  def,
  value,
  onChange,
}: {
  def: PropertyDefinition;
  value: unknown;
  onChange: (value: string | number | boolean | string[] | null) => void;
}) {
  const options = (def.options as { value: string; label: string }[] | null) ?? [];

  if (def.type === "checkbox") {
    return (
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        {def.name}
      </label>
    );
  }

  if (def.type === "select") {
    return (
      <div>
        <p className="mb-1 text-text-3">{def.name}</p>
        <select
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          className="rounded-md border border-border-2 bg-surface px-2 py-1 text-[12.5px] outline-none"
        >
          <option value="">—</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (def.type === "multiSelect") {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div>
        <p className="mb-1 text-text-3">{def.name}</p>
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => {
            const isOn = selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => onChange(isOn ? selected.filter((v) => v !== o.value) : [...selected, o.value])}
                className={`rounded-full border px-2 py-0.5 text-[11px] ${isOn ? "border-indigo bg-indigo-soft text-indigo" : "border-border-2 text-text-2"}`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (def.type === "number") {
    return (
      <div>
        <p className="mb-1 text-text-3">{def.name}</p>
        <input
          type="number"
          defaultValue={typeof value === "number" ? value : ""}
          onBlur={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          className="w-[100px] rounded-md border border-border-2 bg-surface px-2 py-1 text-[12.5px] outline-none"
        />
      </div>
    );
  }

  if (def.type === "date") {
    return (
      <div>
        <p className="mb-1 text-text-3">{def.name}</p>
        <input
          type="date"
          defaultValue={typeof value === "string" ? value : ""}
          onBlur={(e) => onChange(e.target.value || null)}
          className="rounded-md border border-border-2 bg-surface px-2 py-1 text-[12.5px] outline-none"
        />
      </div>
    );
  }

  // text, textarea, url, person — all a plain text input for this pass
  return (
    <div>
      <p className="mb-1 text-text-3">{def.name}</p>
      <input
        defaultValue={typeof value === "string" ? value : ""}
        onBlur={(e) => onChange(e.target.value || null)}
        className="min-w-[140px] rounded-md border border-border-2 bg-surface px-2 py-1 text-[12.5px] outline-none"
      />
    </div>
  );
}
