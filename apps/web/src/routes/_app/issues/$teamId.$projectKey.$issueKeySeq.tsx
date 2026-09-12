import { createFileRoute, Link, useRouter, ClientOnly } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ArrowLeft, Paperclip, X } from "lucide-react";
import type { Block, PartialBlock } from "@blocknote/core";
import { Badge } from "@kompast/ui/Badge";
import { Avatar } from "@kompast/ui/Avatar";
import { Button } from "@kompast/ui/Button";
import { PageContainer } from "@kompast/ui/PageContainer";
import { Tabs } from "@kompast/ui/Tabs";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import {
  getIssueDetailFn,
  addCommentFn,
  toggleWatchFn,
  updateIssueDescriptionFn,
  updateIssueAssigneeFn,
  updateIssuePriorityFn,
  updateIssueCustomFieldFn,
  updateIssueDatesFn,
  updateIssueEpicFn,
} from "@/lib/server-fns/issue-detail";
import { moveIssueFn } from "@/lib/server-fns/issues";
import { addIssueToSprintFn, removeIssueFromSprintFn } from "@/lib/server-fns/sprints";
import { requestAttachmentUploadFn, deleteAttachmentFn } from "@/lib/server-fns/attachments";
import { streamAiCompletion } from "@/lib/ai-stream-client";
import { LiteEditor } from "@/components/shared/LiteEditor";
import { RichTextView, normalizeToBlocks } from "@/components/shared/RichTextView";
import { CommentThread } from "@/components/issues/CommentThread";

export const Route = createFileRoute("/_app/issues/$teamId/$projectKey/$issueKeySeq")({
  loader: ({ params }) =>
    getIssueDetailFn({ data: { teamId: params.teamId, projectKey: params.projectKey, issueKeySeq: Number(params.issueKeySeq) } }),
  component: IssueDetailPage,
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

function IssueDetailPage() {
  const { t, i18n } = useTranslation("issue");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const data = Route.useLoaderData();
  const router = useRouter();
  const [watching, setWatching] = useState(data.isWatching);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<"comments" | "activity">("comments");

  const hasDescription = normalizeToBlocks(data.issue.descriptionJson) !== undefined;
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState<Block[]>([]);
  const [descriptionInitialContent, setDescriptionInitialContent] = useState<PartialBlock[] | undefined>(undefined);
  const [descriptionEditorKey, setDescriptionEditorKey] = useState(0);
  const [savingDescription, setSavingDescription] = useState(false);
  const [aiDraftBusy, setAiDraftBusy] = useState(false);

  const usersById = new Map(data.users.map((u) => [u.id, u]));
  const currentUserName = data.orgMembers.find((m) => m.userId === data.currentUserId)?.name;
  const [changingStatus, setChangingStatus] = useState(false);

  async function toggleWatch() {
    const next = !watching;
    setWatching(next);
    await toggleWatchFn({ data: { issueId: data.issue.id, watching: next } });
  }

  async function setStatus(statusId: string) {
    setChangingStatus(true);
    try {
      await moveIssueFn({ data: { issueId: data.issue.id, toStatusId: statusId } });
      await router.invalidate();
    } finally {
      setChangingStatus(false);
    }
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
      await updateIssueDescriptionFn({
        data: { issueId: data.issue.id, descriptionJson: descriptionDraft.length > 0 ? descriptionDraft : null },
      });
      setEditingDescription(false);
      await router.invalidate();
    } finally {
      setSavingDescription(false);
    }
  }

  /**
   * The AI draft streams plain-text deltas (see streamAiCompletion), but
   * LiteEditor only reads `initialContent` once at mount time — it has no
   * mechanism to accept live external content updates. Rather than attempt
   * live token-by-token editor updates (which would require reaching into
   * BlockNote's imperative API), this accumulates the stream into a plain
   * local string exactly like the old plain-textarea version did, and only
   * converts+loads it into the editor once streaming finishes, by bumping
   * `descriptionEditorKey` to force a remount with fresh `initialContent`.
   * Simpler and safer than live-updating a mounted BlockNote instance, at
   * the cost of not showing AI text appear incrementally in the editor
   * itself (the button's busy label is the only progress indicator while
   * streaming).
   */
  async function generateAiDescriptionDraft() {
    setAiDraftBusy(true);
    let accumulated = "";
    try {
      await streamAiCompletion({ feature: "issue-description", title: data.issue.title }, (delta) => {
        accumulated += delta;
      });
    } catch (err) {
      accumulated = err instanceof Error ? t("aiDraftFailed", { message: err.message }) : t("aiDraftFailedGeneric");
    } finally {
      const blocks: PartialBlock[] = accumulated
        ? [{ type: "paragraph", content: [{ type: "text", text: accumulated, styles: {} }] }]
        : [];
      setDescriptionInitialContent(blocks);
      setDescriptionDraft(blocks as Block[]);
      setDescriptionEditorKey((k) => k + 1);
      setAiDraftBusy(false);
    }
  }

  async function setStartDate(value: string | null) {
    await updateIssueDatesFn({ data: { issueId: data.issue.id, startDate: value ? new Date(value).toISOString() : null } });
    await router.invalidate();
  }

  async function setDueDate(value: string | null) {
    await updateIssueDatesFn({ data: { issueId: data.issue.id, dueDate: value ? new Date(value).toISOString() : null } });
    await router.invalidate();
  }

  async function setEpic(epicId: string | null) {
    await updateIssueEpicFn({ data: { issueId: data.issue.id, epicId } });
    await router.invalidate();
  }

  async function setSprint(sprintId: string | null) {
    if (sprintId) {
      await addIssueToSprintFn({ data: { sprintId, issueId: data.issue.id } });
    } else {
      await removeIssueFromSprintFn({ data: data.issue.id });
    }
    await router.invalidate();
  }

  return (
    <PageContainer width="dense">
      <Link
        to="/projects/$teamId/$projectKey"
        params={{ teamId: data.project.teamId ?? "none", projectKey: data.project.key }}
        className="mb-4 inline-flex items-center gap-1 text-xs text-text-3 hover:text-text-2"
      >
        <ArrowLeft size={13} strokeWidth={1.75} /> {data.project.name}
      </Link>

      <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[1fr_260px]">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <span className="type-label text-text-3">
              {data.project.key}-{data.issue.keySeq}
            </span>
            {data.type && <Badge tone="indigo">{data.type.name}</Badge>}
            {data.status && (
              <StatusSelect
                statuses={data.statuses}
                value={data.issue.statusId}
                disabled={changingStatus}
                onChange={setStatus}
                label={t("statusLabel")}
              />
            )}
          </div>
          <h1 className="mb-1 type-title">{data.issue.title}</h1>
          <p className="mb-8 type-label text-text-3">
            {t("createdUpdatedMeta", {
              created: new Date(data.issue.createdAt).toLocaleDateString(intlLocale, { day: "numeric", month: "short", year: "numeric" }),
              updated: new Date(data.issue.updatedAt).toLocaleDateString(intlLocale, { day: "numeric", month: "short", year: "numeric" }),
            })}
          </p>

          <section className="mb-8">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="type-headline">{t("descriptionHeading")}</h2>
              {!editingDescription && (
                <Button
                  variant="outline"
                  onClick={() => {
                    const blocks = normalizeToBlocks(data.issue.descriptionJson) ?? [];
                    setDescriptionInitialContent(blocks);
                    setDescriptionDraft(blocks as Block[]);
                    setDescriptionEditorKey((k) => k + 1);
                    setEditingDescription(true);
                  }}
                >
                  {hasDescription ? t("edit") : t("addDescription")}
                </Button>
              )}
            </div>
            {editingDescription ? (
              <div className="flex flex-col gap-2">
                <ClientOnly fallback={<div className="min-h-[140px] rounded-[7px] border border-border bg-surface" />}>
                  <LiteEditor
                    key={descriptionEditorKey}
                    initialContent={descriptionInitialContent}
                    onChange={setDescriptionDraft}
                    autoFocus
                    placeholder={t("descriptionPlaceholder")}
                    className="min-h-[140px] rounded-[7px] border border-border bg-surface p-3 outline-none focus-within:border-border-2"
                  />
                </ClientOnly>
                <div className="flex items-center gap-2">
                  <Button variant="primary" onClick={saveDescription} disabled={savingDescription}>
                    {savingDescription ? t("savingEllipsis") : t("save")}
                  </Button>
                  <Button variant="outline" onClick={() => setEditingDescription(false)} disabled={savingDescription}>
                    {t("cancel")}
                  </Button>
                  <Button variant="outline" onClick={generateAiDescriptionDraft} disabled={aiDraftBusy}>
                    {aiDraftBusy ? t("aiDraftingEllipsis") : t("aiDraftButton")}
                  </Button>
                </div>
              </div>
            ) : hasDescription ? (
              <ClientOnly fallback={<div className="min-h-[24px]" />}>
                <RichTextView content={data.issue.descriptionJson} className="type-body leading-snug text-text-2" />
              </ClientOnly>
            ) : (
              <p className="type-body text-text-3">{t("noDescriptionYet")}</p>
            )}
          </section>

          <section className="mb-8">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="type-headline">{t("attachmentsHeading")}</h2>
              <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                {uploading ? t("uploadingEllipsis") : t("attachButton")}
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
              <p className="type-body text-text-3">{t("noAttachmentsYet")}</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {data.attachments.map((a) => (
                  <div key={a.id} className="flex items-center gap-2.5 rounded-[9px] border border-border bg-surface px-3 py-2">
                    <Paperclip size={14} strokeWidth={1.75} className="flex-none text-text-3" />
                    <a
                      href={a.downloadUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 flex-1 truncate type-body text-accent hover:underline"
                    >
                      {a.fileName}
                    </a>
                    <span className="type-label text-text-3">{(a.sizeBytes / 1024).toFixed(0)} KB</span>
                    <button
                      onClick={() => removeAttachment(a.id)}
                      className="rounded-[7px] px-1 py-0.5 text-text-3 hover:bg-danger-soft hover:text-danger"
                    >
                      <X size={13} strokeWidth={1.75} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="rounded-xl border border-border bg-surface p-4">
            <Tabs
              items={[
                { key: "comments", label: t("commentsHeading") },
                { key: "activity", label: t("activityHeading") },
              ]}
              active={activeTab}
              onChange={(key) => setActiveTab(key as "comments" | "activity")}
              className="mb-4"
            />
            {activeTab === "comments" && (
              <CommentThread
                comments={data.comments}
                usersById={usersById}
                intlLocale={intlLocale}
                currentUserName={currentUserName}
                onSubmit={async ({ bodyJson, parentCommentId }) => {
                  await addCommentFn({ data: { issueId: data.issue.id, bodyJson, parentCommentId } });
                  await router.invalidate();
                }}
              />
            )}
            {activeTab === "activity" && (
              <div className="flex flex-col gap-2">
                {data.history.length === 0 && <p className="type-body text-text-3">{t("noActivityYet")}</p>}
                {data.history.map((h) => (
                  <p key={h.id} className="text-[12px] text-text-2">
                    <span className="font-mono text-text-3">{new Date(h.createdAt).toLocaleString(intlLocale)}</span>{" "}
                    {h.field === "created" ? t("historyCreated") : `${h.field}: ${h.fromValue ?? "—"} → ${h.toValue ?? "—"}`}
                    {h.origin !== "user" && <span className="ml-1 text-text-3">{t("historyOrigin", { origin: h.originClient ?? h.origin })}</span>}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 text-[12.5px]">
          <Button variant={watching ? "primary" : "outline"} onClick={toggleWatch} className="w-full">
            {watching ? t("watching") : t("watch")}
          </Button>

          <div className="flex flex-col gap-4 border-t border-border pt-4">
            <div>
              <p className="mb-1 text-text-3">{t("assigneeLabel")}</p>
              <select
                value={data.issue.assigneeId ?? ""}
                onChange={(e) => setAssignee(e.target.value)}
                className="kp-select kp-field w-full"
              >
                <option value="">{t("unassigned")}</option>
                {data.orgMembers.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <p className="mb-1 text-text-3">{t("reporterLabel")}</p>
              <span className="inline-flex items-center gap-1.5">
                <Avatar initials={initialsOf(usersById.get(data.issue.reporterId)?.name ?? "?")} size={18} />
                {usersById.get(data.issue.reporterId)?.name ?? "—"}
              </span>
            </div>
            <div>
              <p className="mb-1 text-text-3">{t("priorityLabel")}</p>
              <div className="relative">
                <span
                  className="pointer-events-none absolute left-2.5 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
                  style={{ background: data.priorityLevels.find((p) => p.key === data.issue.priority)?.color }}
                />
                <select
                  value={data.issue.priority}
                  onChange={(e) => setPriority(e.target.value)}
                  className="kp-select kp-field w-full"
                  style={{ paddingLeft: 22 }}
                >
                  {[...data.priorityLevels].sort((a, b) => a.order - b.order).map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <p className="mb-1 text-text-3">{t("startDateLabel")}</p>
              <input
                type="date"
                value={data.issue.startDate ? new Date(data.issue.startDate).toISOString().slice(0, 10) : ""}
                onChange={(e) => setStartDate(e.target.value || null)}
                className="kp-field w-full"
              />
            </div>
            <div>
              <p className="mb-1 text-text-3">{t("dueDateLabel")}</p>
              <input
                type="date"
                value={data.issue.dueDate ? new Date(data.issue.dueDate).toISOString().slice(0, 10) : ""}
                onChange={(e) => setDueDate(e.target.value || null)}
                className="kp-field w-full"
              />
            </div>
            {data.type?.hierarchyLevel !== 0 && (
              <div>
                <p className="mb-1 text-text-3">{t("epicLabel")}</p>
                <select
                  value={data.issue.epicId ?? ""}
                  onChange={(e) => setEpic(e.target.value || null)}
                  className="kp-select kp-field w-full"
                >
                  <option value="">{t("noEpic")}</option>
                  {data.candidateEpics.map((e) => (
                    <option key={e.id} value={e.id}>
                      {data.project.key}-{e.keySeq} {e.title}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <p className="mb-1 text-text-3">{t("sprintLabel")}</p>
              <select
                value={data.issue.sprintId ?? ""}
                onChange={(e) => setSprint(e.target.value || null)}
                className="kp-select kp-field w-full"
              >
                <option value="">{t("backlogLabel")}</option>
                {data.boardSprints
                  .filter((s) => s.state !== "closed" || s.id === data.issue.sprintId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </div>
            {data.issue.storyPoints != null && (
              <div>
                <p className="mb-1 text-text-3">{t("pointsLabel")}</p>
                <span className="type-label">{data.issue.storyPoints}</span>
              </div>
            )}
          </div>

          {data.propertyDefinitions.length > 0 && (
            <CustomPropertiesSection
              definitions={data.propertyDefinitions}
              customFields={(data.issue.customFields ?? {}) as Record<string, unknown>}
              onChange={setCustomField}
            />
          )}
        </div>
      </div>
    </PageContainer>
  );
}

type StatusOption = Awaited<ReturnType<typeof getIssueDetailFn>>["statuses"][number];

/**
 * A colored, pill-shaped status dropdown — mirrors how Card.tsx colors the
 * board's priority dot from DB-stored hex, since workflow statuses are
 * per-project/admin-configurable and can't be limited to Badge's six fixed
 * tones. Uses backgroundColor (not the `background` shorthand) in the
 * inline style so it doesn't blank out .kp-select's own background-image
 * chevron.
 */
function StatusSelect({
  statuses,
  value,
  disabled,
  onChange,
  label,
}: {
  statuses: StatusOption[];
  value: string;
  disabled?: boolean;
  onChange: (statusId: string) => void;
  label: string;
}) {
  const color = statuses.find((s) => s.id === value)?.color ?? "var(--text-3)";
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="kp-select kp-pill-select rounded-full py-0.5 pl-2.5 text-[10.5px] font-semibold uppercase tracking-[0.05em]"
      style={{ backgroundColor: `color-mix(in srgb, ${color} 16%, var(--surface))`, color }}
    >
      {statuses.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
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
  const { t } = useTranslation("issue");
  return (
    <div className="border-t border-border pt-4">
      <p className="mb-3 type-headline">{t("customPropertiesHeading")}</p>
      <div className="flex flex-col gap-4">
        {definitions.map((def) => (
          <CustomPropertyField key={def.id} def={def} value={customFields[def.key]} onChange={(v) => onChange(def.key, v)} />
        ))}
      </div>
    </div>
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
          className="kp-select kp-field w-full"
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
          className="kp-field w-full"
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
          className="kp-field"
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
        className="kp-field w-full"
      />
    </div>
  );
}
