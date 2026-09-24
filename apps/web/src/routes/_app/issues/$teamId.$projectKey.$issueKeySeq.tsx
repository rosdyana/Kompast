import { createFileRoute, Link, useRouter, ClientOnly } from "@tanstack/react-router";
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import type { Block, PartialBlock } from "@blocknote/core";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Eye,
  Link2,
  ListTree,
  MoreHorizontal,
  Paperclip,
  Sparkles,
} from "lucide-react";
import { Avatar, UnassignedAvatar } from "@kompast/ui/Avatar";
import { Button, IconButton } from "@kompast/ui/Button";
import { Dialog } from "@kompast/ui/Dialog";
import { IssueTypeIcon } from "@kompast/ui/IssueTypeIcon";
import { Lozenge, StatusDot } from "@kompast/ui/Lozenge";
import { MenuItem, MenuList } from "@kompast/ui/Menu";
import { Popover } from "@kompast/ui/Popover";
import { PriorityIcon } from "@kompast/ui/PriorityIcon";
import { SelectMenu, type SelectOption } from "@kompast/ui/SelectMenu";
import { Tabs } from "@kompast/ui/Tabs";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation } from "@kompast/i18n";
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
  updateIssueTitleFn,
  updateIssueTypeFn,
  updateIssueLabelsFn,
  updateIssueStoryPointsFn,
  archiveIssueFn,
  restoreIssueFn,
} from "@/lib/server-fns/issue-detail";
import { moveIssueFn } from "@/lib/server-fns/issues";
import { addIssueToSprintFn, removeIssueFromSprintFn } from "@/lib/server-fns/sprints";
import { requestAttachmentUploadFn, deleteAttachmentFn } from "@/lib/server-fns/attachments";
import { streamAiCompletion } from "@/lib/ai-stream-client";
import { cn } from "@/lib/cn";
import { LiteEditor } from "@/components/shared/LiteEditor";
import { RichTextView, normalizeToBlocks } from "@/components/shared/RichTextView";
import { CommentThread } from "@/components/issues/CommentThread";
import { HistoryTimeline } from "@/components/issues/HistoryTimeline";
import { Attachments } from "@/components/issues/Attachments";
import { ChildIssues } from "@/components/issues/ChildIssues";
import { DetailRow, EmptyValue, InlineDate, InlineInput, InlineMultiPicker, InlinePicker, LabelsEditor } from "@/components/issues/DetailFields";
import { fullDateTime, intlLocaleOf, relativeTime, shortDate, toDateInput } from "@/components/issues/time";
import { ProjectIcon } from "@/components/shell/ProjectIcon";
import { usePageChrome, useWorkbench, type Crumb } from "@/components/shell/WorkbenchContext";

/** Crumb.link is typed as the generic Link props (every route's params), so
 * route-specific params need a cast at the boundary. */
const crumbLink = (link: object) => link as unknown as Crumb["link"];

type FromTab = "board" | "backlog" | "table";
const FROM_TABS: FromTab[] = ["board", "backlog", "table"];

export const Route = createFileRoute("/_app/issues/$teamId/$projectKey/$issueKeySeq")({
  // Which project tab "back" returns to — set by the Link that opened this
  // issue (board card, backlog row, sprint table). Any other entry point
  // (search, mentions, palette) falls back to Backlog.
  validateSearch: (search: Record<string, unknown>): { from?: FromTab } => ({
    from: FROM_TABS.includes(search.from as FromTab) ? (search.from as FromTab) : undefined,
  }),
  loader: ({ params }) =>
    getIssueDetailFn({ data: { teamId: params.teamId, projectKey: params.projectKey, issueKeySeq: Number(params.issueKeySeq) } }),
  component: IssueDetailRoute,
});

type IssueData = Awaited<ReturnType<typeof getIssueDetailFn>>;

/**
 * The route component instance is reused when navigating between two
 * issues (same route, new params), so every piece of local state — title
 * draft, watch toggle, editor drafts, uncontrolled inputs — would otherwise
 * carry over from the previous issue. Keying the view on the issue id gives
 * each issue a fresh instance.
 */
function IssueDetailRoute() {
  const data = Route.useLoaderData();
  const from = Route.useSearch().from ?? "backlog";
  return <IssueView key={data.issue.id} data={data} from={from} />;
}

function IssueView({ data, from }: { data: IssueData; from: FromTab }) {
  const { t, i18n } = useTranslation(["issue", "common"]);
  const intlLocale = intlLocaleOf(i18n.language);
  const router = useRouter();
  const toast = useToast();
  const { openCreateIssue } = useWorkbench();

  const teamId = data.project.teamId ?? "none";
  const issueKey = `${data.project.key}-${data.issue.keySeq}`;
  const usersById = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>(data.users.map((u) => [u.id, { id: u.id, name: u.name }]));
    for (const om of data.orgMembers) if (!m.has(om.userId)) m.set(om.userId, { id: om.userId, name: om.name });
    return m;
  }, [data.users, data.orgMembers]);
  const typesById = useMemo(() => new Map(data.allTypes.map((tp) => [tp.id, tp])), [data.allTypes]);
  const statusesById = useMemo(() => new Map(data.statuses.map((s) => [s.id, s])), [data.statuses]);
  const priorityByKey = useMemo(() => new Map(data.priorityLevels.map((p) => [p.key, p])), [data.priorityLevels]);
  const currentUserName = usersById.get(data.currentUserId)?.name;
  const isEpic = data.type?.hierarchyLevel === 0;
  const subtaskType = data.allTypes.find((tp) => tp.isSubtask);

  const [watching, setWatching] = useState(data.isWatching);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [activityTab, setActivityTab] = useState<"comments" | "history">("comments");
  const [uploading, setUploading] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(true);

  /** Every field mutation: run, refresh loader data, surface failures as a toast. */
  async function save(fn: () => Promise<unknown>) {
    try {
      await fn();
      await router.invalidate();
    } catch (err) {
      toast.show({ tone: "error", title: t("saveFailed", { message: err instanceof Error ? err.message : String(err) }) });
    }
  }

  async function toggleWatch() {
    const next = !watching;
    setWatching(next);
    try {
      await toggleWatchFn({ data: { issueId: data.issue.id, watching: next } });
    } catch (err) {
      setWatching(!next);
      toast.show({ tone: "error", title: t("saveFailed", { message: err instanceof Error ? err.message : String(err) }) });
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.origin + window.location.pathname);
      toast.show({ title: t("linkCopied"), description: issueKey });
    } catch {
      toast.show({ tone: "error", title: t("common:somethingWentWrong") });
    }
  }

  async function archive() {
    setConfirmArchive(false);
    await save(() => archiveIssueFn({ data: { issueId: data.issue.id } }));
    toast.show({ title: t("archivedToast", { key: issueKey }) });
  }

  async function restore() {
    setMoreOpen(false);
    await save(() => restoreIssueFn({ data: { issueId: data.issue.id } }));
    toast.show({ title: t("restoredToast", { key: issueKey }) });
  }

  async function uploadFiles(files: File[]) {
    for (const file of files) {
      setUploading((u) => [...u, file.name]);
      try {
        const { uploadUrl, headers } = await requestAttachmentUploadFn({
          data: { issueId: data.issue.id, fileName: file.name, contentType: file.type || "application/octet-stream", sizeBytes: file.size },
        });
        const res = await fetch(uploadUrl, { method: "PUT", headers, body: file });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        toast.show({ tone: "error", title: t("uploadFailed", { message: err instanceof Error ? err.message : String(err) }), description: file.name });
      } finally {
        setUploading((u) => u.filter((n) => n !== file.name));
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
    await router.invalidate();
  }

  const epicCrumb = data.epic ?? null;
  const parentCrumb = data.parent ?? null;

  usePageChrome(
    {
      crumbs: [
        { label: t("breadcrumbProjects") },
        {
          label: data.project.name,
          icon: <ProjectIcon projectKey={data.project.key} size={16} />,
          link: crumbLink({ to: "/projects/$teamId/$projectKey", params: { teamId, projectKey: data.project.key }, search: { tab: from } }),
        },
        ...(epicCrumb
          ? [
              {
                label: `${data.project.key}-${epicCrumb.keySeq}`,
                icon: <IssueTypeIcon type={{ name: "Epic", hierarchyLevel: 0 }} size={14} />,
                link: crumbLink({ to: "/issues/$teamId/$projectKey/$issueKeySeq", params: { teamId, projectKey: data.project.key, issueKeySeq: String(epicCrumb.keySeq) } }),
              },
            ]
          : []),
        ...(parentCrumb
          ? [
              {
                label: `${data.project.key}-${parentCrumb.keySeq}`,
                icon: <IssueTypeIcon type={typesById.get(parentCrumb.typeId)} size={14} />,
                link: crumbLink({ to: "/issues/$teamId/$projectKey/$issueKeySeq", params: { teamId, projectKey: data.project.key, issueKeySeq: String(parentCrumb.keySeq) } }),
              },
            ]
          : []),
        { label: issueKey, icon: <IssueTypeIcon type={data.type} size={14} /> },
      ],
      actions: (
        <>
          <Button variant="ghost" size="sm" onClick={toggleWatch} aria-pressed={watching} title={watching ? t("watching") : t("watch")}>
            <Eye size={15} className={watching ? "text-accent" : undefined} />
            <span className="hidden sm:inline">{watching ? t("watching") : t("watch")}</span>
          </Button>
          <IconButton aria-label={t("copyLink")} title={t("copyLink")} onClick={copyLink}>
            <Link2 size={16} />
          </IconButton>
          {data.canManageProject && (
            <IconButton ref={moreRef} aria-label={t("moreActions")} title={t("moreActions")} onClick={() => setMoreOpen((v) => !v)}>
              <MoreHorizontal size={16} />
            </IconButton>
          )}
        </>
      ),
    },
    [data.issue.id, data.issue.archivedAt, data.project.name, watching, from, epicCrumb?.id, parentCrumb?.id, data.canManageProject, i18n.language],
  );

  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 pb-20 pt-5 sm:px-8">
      <Popover open={moreOpen} onClose={() => setMoreOpen(false)} anchorRef={moreRef} placement="bottom-end" width={220} role="menu">
        <MenuList>
          {data.issue.archivedAt ? (
            <MenuItem icon={<ArchiveRestore size={15} />} onClick={restore}>
              {t("restore")}
            </MenuItem>
          ) : (
            <MenuItem
              icon={<Archive size={15} />}
              danger
              onClick={() => {
                setMoreOpen(false);
                setConfirmArchive(true);
              }}
            >
              {t("archiveAction")}
            </MenuItem>
          )}
        </MenuList>
      </Popover>

      <Dialog
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        size="sm"
        title={t("archiveConfirmTitle", { key: issueKey })}
        description={t("archiveConfirmBody")}
        closeLabel={t("common:close")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmArchive(false)}>
              {t("cancel")}
            </Button>
            <Button variant="danger" onClick={archive} data-autofocus>
              {t("archiveAction")}
            </Button>
          </>
        }
      >
        <span />
      </Dialog>

      {data.issue.archivedAt && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-[8px] border border-amber/30 bg-amber-soft px-4 py-2.5 text-[13.5px] text-amber">
          <Archive size={16} className="flex-none" />
          <span className="min-w-0 flex-1">{t("archivedBanner.message")}</span>
          {data.canManageProject && (
            <Button variant="outline" size="sm" onClick={restore}>
              {t("restore")}
            </Button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Main column */}
        <div className="order-1 min-w-0 max-w-[780px]">
          <IssueTitle
            title={data.issue.title}
            onSave={(title) => save(() => updateIssueTitleFn({ data: { issueId: data.issue.id, title } }))}
          />

          <div className="mb-6 mt-3 flex flex-wrap items-center gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
              <Paperclip size={14} />
              {t("attachButton")}
            </Button>
            {!isEpic && subtaskType && !data.type?.isSubtask && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openCreateIssue({ projectId: data.project.id, parentId: data.issue.id, typeId: subtaskType.id })}
              >
                <ListTree size={14} />
                {t("createSubtask")}
              </Button>
            )}
            {isEpic && (
              <Button variant="secondary" size="sm" onClick={() => openCreateIssue({ projectId: data.project.id, epicId: data.issue.id })}>
                <ListTree size={14} />
                {t("addChildIssue")}
              </Button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                if (files.length) uploadFiles(files);
              }}
            />
          </div>

          <Section title={t("descriptionHeading")}>
            <DescriptionEditor
              issueId={data.issue.id}
              issueTitle={data.issue.title}
              descriptionJson={data.issue.descriptionJson}
              onSaved={() => router.invalidate()}
            />
          </Section>

          {(data.children.length > 0 || isEpic || (subtaskType && !data.type?.isSubtask)) && (
            <Section title={isEpic ? t("epicChildren") : t("childIssuesHeading")}>
              <ChildIssues
                children={data.children}
                typesById={typesById}
                statusesById={statusesById}
                priorityByKey={priorityByKey}
                teamId={teamId}
                projectKey={data.project.key}
              />
            </Section>
          )}

          {(data.attachments.length > 0 || uploading.length > 0) && (
            <Section title={`${t("attachmentsHeading")} · ${data.attachments.length}`}>
              <Attachments
                attachments={data.attachments}
                uploading={uploading}
                onUpload={uploadFiles}
                onRemove={(attachmentId) => save(() => deleteAttachmentFn({ data: { attachmentId, issueId: data.issue.id } }))}
                intlLocale={intlLocale}
              />
            </Section>
          )}

          {/* On mobile the details panel sits here, above activity. */}
          <div className="mb-8 lg:hidden">
            {renderSidePanel()}
          </div>

          <Section
            title={t("activityHeading")}
            aside={
              <Tabs
                variant="pill"
                items={[
                  { key: "comments", label: t("commentsHeading") },
                  { key: "history", label: t("historyTab") },
                ]}
                active={activityTab}
                onChange={(k) => setActivityTab(k as "comments" | "history")}
              />
            }
          >
            {activityTab === "comments" ? (
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
            ) : (
              <HistoryTimeline
                entries={data.history}
                intlLocale={intlLocale}
                actorName={(h) => (h.origin === "automation" ? t("historyActorSystem") : (h.actorId && usersById.get(h.actorId)?.name) || t("unknownAuthor"))}
                renderValue={renderHistoryValue}
              />
            )}
          </Section>
        </div>

        {/* Right sidebar (desktop) */}
        <aside className="order-2 hidden lg:sticky lg:top-5 lg:block">
          {renderSidePanel()}
        </aside>
      </div>
    </div>
  );

  function renderHistoryValue(field: string, raw: string | null): ReactNode {
    if (raw == null || raw === "") return <span className="text-text-3">{t("none")}</span>;
    if (field === "status") {
      const s = statusesById.get(raw);
      return s ? <Lozenge color={s.color}>{s.name}</Lozenge> : raw;
    }
    if (field === "assigneeId") {
      const u = usersById.get(raw);
      return u ? (
        <span className="inline-flex items-center gap-1.5">
          <Avatar name={u.name} size={18} />
          {u.name}
        </span>
      ) : (
        raw
      );
    }
    if (field === "typeId") {
      const tp = typesById.get(raw);
      return tp ? (
        <span className="inline-flex items-center gap-1.5">
          <IssueTypeIcon type={tp} size={14} />
          {tp.name}
        </span>
      ) : (
        raw
      );
    }
    if (field === "priority") {
      const p = priorityByKey.get(raw);
      return p ? <PriorityIcon priority={p} showLabel /> : raw;
    }
    if (field === "epicId" || field === "parentId") {
      const epic = data.candidateEpics.find((e) => e.id === raw);
      return epic ? `${data.project.key}-${epic.keySeq} ${epic.title}` : raw;
    }
    if (field === "sprint") return data.boardSprints.find((s) => s.id === raw)?.name ?? raw;
    if (field === "dueDate" || field === "startDate") {
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? raw : shortDate(d, intlLocale);
    }
    return raw;
  }

  function renderSidePanel() {
    const status = statusesById.get(data.issue.statusId);
    const statusOptions: SelectOption[] = data.statuses.map((s) => ({ value: s.id, label: s.name, icon: <StatusDot color={s.color} /> }));
    const assignee = data.issue.assigneeId ? usersById.get(data.issue.assigneeId) : undefined;
    const reporter = usersById.get(data.issue.reporterId);
    const priority = priorityByKey.get(data.issue.priority);
    const due = data.issue.dueDate ? new Date(data.issue.dueDate) : null;
    const overdue = !!due && status?.category !== "done" && due.getTime() < Date.now() - 86_400_000;
    const epic = data.candidateEpics.find((e) => e.id === data.issue.epicId);

    const memberOptions: SelectOption[] = [
      { value: "", label: t("unassigned"), icon: <UnassignedAvatar size={20} /> },
      ...[...data.orgMembers].sort((a, b) => a.name.localeCompare(b.name)).map((m) => ({ value: m.userId, label: m.name, icon: <Avatar name={m.name} size={20} /> })),
    ];

    const core: Record<string, () => ReactNode> = {
      assignee: () => (
        <DetailRow label={t("assigneeLabel")} align="start">
          <InlinePicker
            ariaLabel={t("assigneeLabel")}
            options={memberOptions}
            value={data.issue.assigneeId ?? ""}
            onSelect={(v) => save(() => updateIssueAssigneeFn({ data: { issueId: data.issue.id, assigneeId: v || null } }))}
            display={
              assignee ? (
                <>
                  <Avatar name={assignee.name} size={22} />
                  <span className="truncate">{assignee.name}</span>
                </>
              ) : (
                <>
                  <UnassignedAvatar size={22} />
                  <EmptyValue>{t("unassigned")}</EmptyValue>
                </>
              )
            }
          />
          {data.issue.assigneeId !== data.currentUserId && (
            <button
              type="button"
              onClick={() => save(() => updateIssueAssigneeFn({ data: { issueId: data.issue.id, assigneeId: data.currentUserId } }))}
              className="ml-2 text-[12.5px] font-medium text-accent-text hover:underline"
            >
              {t("assignToMe")}
            </button>
          )}
        </DetailRow>
      ),
      reporter: () => (
        <DetailRow label={t("reporterLabel")}>
          <span className="flex min-h-8 items-center gap-2 px-2 text-[14px]">
            {reporter ? (
              <>
                <Avatar name={reporter.name} size={22} />
                <span className="truncate">{reporter.name}</span>
              </>
            ) : (
              <EmptyValue>—</EmptyValue>
            )}
          </span>
        </DetailRow>
      ),
      priority: () => (
        <DetailRow label={t("priorityLabel")}>
          <InlinePicker
            ariaLabel={t("priorityLabel")}
            options={[...data.priorityLevels].sort((a, b) => a.order - b.order).map((p) => ({ value: p.key, label: p.name, icon: <PriorityIcon priority={p} /> }))}
            value={data.issue.priority}
            onSelect={(v) => save(() => updateIssuePriorityFn({ data: { issueId: data.issue.id, priority: v } }))}
            display={priority ? <PriorityIcon priority={priority} showLabel /> : <EmptyValue>{data.issue.priority}</EmptyValue>}
          />
        </DetailRow>
      ),
      type: () => {
        const sameLevel = data.allTypes.filter((tp) => tp.hierarchyLevel === data.type?.hierarchyLevel);
        return (
          <DetailRow label={t("typeLabel")}>
            <InlinePicker
              ariaLabel={t("typeLabel")}
              disabled={sameLevel.length < 2}
              options={sameLevel.map((tp) => ({ value: tp.id, label: tp.name, icon: <IssueTypeIcon type={tp} size={16} /> }))}
              value={data.issue.typeId}
              onSelect={(v) => save(() => updateIssueTypeFn({ data: { issueId: data.issue.id, typeId: v } }))}
              display={
                <>
                  <IssueTypeIcon type={data.type} size={16} />
                  <span className="truncate">{data.type?.name}</span>
                </>
              }
            />
          </DetailRow>
        );
      },
      sprint: () =>
        isEpic ? null : (
          <DetailRow label={t("sprintLabel")}>
            <InlinePicker
              ariaLabel={t("sprintLabel")}
              options={[
                { value: "", label: t("backlogLabel") },
                ...data.boardSprints
                  .filter((s) => s.state !== "closed" || s.id === data.issue.sprintId)
                  .map((s) => ({ value: s.id, label: s.name, hint: s.state === "active" ? "●" : undefined })),
              ]}
              value={data.issue.sprintId ?? ""}
              onSelect={(v) =>
                save(() => (v ? addIssueToSprintFn({ data: { sprintId: v, issueId: data.issue.id } }) : removeIssueFromSprintFn({ data: data.issue.id })))
              }
              display={
                data.issue.sprintId ? (
                  <span className="truncate">{data.boardSprints.find((s) => s.id === data.issue.sprintId)?.name}</span>
                ) : (
                  <EmptyValue>{t("backlogLabel")}</EmptyValue>
                )
              }
            />
          </DetailRow>
        ),
      epic: () =>
        isEpic ? null : (
          <DetailRow label={t("epicLabel")}>
            <InlinePicker
              ariaLabel={t("epicLabel")}
              options={[
                { value: "", label: t("noEpic") },
                ...data.candidateEpics.map((e) => ({ value: e.id, label: e.title, hint: `${data.project.key}-${e.keySeq}` })),
              ]}
              value={data.issue.epicId ?? ""}
              onSelect={(v) => save(() => updateIssueEpicFn({ data: { issueId: data.issue.id, epicId: v || null } }))}
              display={
                epic ? (
                  <span className="inline-flex h-6 min-w-0 items-center gap-1.5 rounded-[4px] bg-violet-soft px-1.5 text-[13px] font-medium text-violet">
                    <IssueTypeIcon type={{ name: "Epic", hierarchyLevel: 0 }} size={14} />
                    <span className="truncate">{epic.title}</span>
                  </span>
                ) : (
                  <EmptyValue>{t("noEpic")}</EmptyValue>
                )
              }
            />
          </DetailRow>
        ),
      storyPoints: () => (
        <DetailRow label={t("pointsLabel")}>
          <InlineInput
            type="number"
            ariaLabel={t("pointsLabel")}
            placeholder={t("none")}
            value={data.issue.storyPoints == null ? "" : String(data.issue.storyPoints)}
            onCommit={(v) => {
              const n = v === "" ? null : Number(v);
              if (n !== null && (Number.isNaN(n) || n < 0)) return;
              save(() => updateIssueStoryPointsFn({ data: { issueId: data.issue.id, storyPoints: n } }));
            }}
          />
        </DetailRow>
      ),
      startDate: () => (
        <DetailRow label={t("startDateLabel")}>
          <InlineDate
            ariaLabel={t("startDateLabel")}
            value={toDateInput(data.issue.startDate)}
            onCommit={(v) => save(() => updateIssueDatesFn({ data: { issueId: data.issue.id, startDate: v ? new Date(v).toISOString() : null } }))}
          />
        </DetailRow>
      ),
      dueDate: () => (
        <DetailRow label={t("dueDateLabel")}>
          <div className="flex items-center gap-1.5">
            <InlineDate
              ariaLabel={t("dueDateLabel")}
              tone={overdue ? "danger" : undefined}
              value={toDateInput(data.issue.dueDate)}
              onCommit={(v) => save(() => updateIssueDatesFn({ data: { issueId: data.issue.id, dueDate: v ? new Date(v).toISOString() : null } }))}
            />
            {overdue && <span className="flex-none rounded-[4px] bg-danger-soft px-1.5 text-[11.5px] font-semibold text-danger">{t("overdue")}</span>}
          </div>
        </DetailRow>
      ),
      labels: () => (
        <DetailRow label={t("labelsLabel")} align="start">
          <LabelsEditor labels={data.issue.labels} onChange={(labels) => save(() => updateIssueLabelsFn({ data: { issueId: data.issue.id, labels } }))} />
        </DetailRow>
      ),
    };

    const customValues = (data.issue.customFields ?? {}) as Record<string, unknown>;

    return (
      <div className="flex flex-col gap-3">
        <StatusControl
          status={status}
          options={statusOptions}
          value={data.issue.statusId}
          label={t("changeStatus")}
          onSelect={(v) => save(() => moveIssueFn({ data: { issueId: data.issue.id, toStatusId: v } }))}
        />
        <div className="overflow-hidden rounded-[10px] border border-border bg-surface">
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            aria-expanded={detailsOpen}
            className="flex h-11 w-full items-center justify-between border-b border-border px-4 text-left text-[14px] font-semibold hover:bg-surface-2"
          >
            {t("detailsHeading")}
            <ChevronDown size={16} className={cn("text-text-3 transition-transform", !detailsOpen && "-rotate-90")} />
          </button>
          {detailsOpen && (
            <div className="flex flex-col gap-1.5 px-3 py-3">
              {data.propertyDefinitions.map((def) => {
                if (def.isCore) {
                  const render = core[def.key];
                  return render ? <Fragment key={def.id}>{render()}</Fragment> : null;
                }
                return (
                  <CustomPropertyRow
                    key={def.id}
                    def={def}
                    value={customValues[def.key]}
                    members={data.orgMembers}
                    onChange={(v) => save(() => updateIssueCustomFieldFn({ data: { issueId: data.issue.id, key: def.key, value: v } }))}
                  />
                );
              })}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-0.5 px-1 text-[12.5px] text-text-3">
          <span title={fullDateTime(data.issue.createdAt, intlLocale)}>{t("createdAgo", { time: relativeTime(data.issue.createdAt, intlLocale) })}</span>
          <span title={fullDateTime(data.issue.updatedAt, intlLocale)}>{t("updatedAgo", { time: relativeTime(data.issue.updatedAt, intlLocale) })}</span>
        </div>
      </div>
    );
  }
}

function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-2.5 flex min-h-8 items-center justify-between gap-3">
        <h2 className="type-headline">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Notion-like title: reads as a heading, becomes an input on click. */
function IssueTitle({ title, onSave }: { title: string; onSave: (title: string) => void }) {
  const { t } = useTranslation("issue");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  function commit() {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed && trimmed !== title) onSave(trimmed);
    else setDraft(title);
  }

  if (editing) {
    return (
      <textarea
        autoFocus
        rows={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\n/g, ""))}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            setDraft(title);
            setEditing(false);
          }
        }}
        className="-mx-2 block w-[calc(100%+16px)] resize-none rounded-[6px] border border-accent bg-surface px-2 py-1 text-[24px] font-semibold leading-tight tracking-[-0.015em] shadow-[0_0_0_3px_var(--accent-soft)] outline-none [field-sizing:content]"
      />
    );
  }
  return (
    <h1
      onClick={() => {
        setDraft(title);
        setEditing(true);
      }}
      title={t("clickToEdit")}
      className="-mx-2 cursor-text rounded-[6px] px-2 py-1 text-[24px] font-semibold leading-tight tracking-[-0.015em] text-text hover:bg-surface-3"
    >
      {title}
    </h1>
  );
}

function StatusControl({
  status,
  options,
  value,
  label,
  onSelect,
}: {
  status: { name: string; color: string } | undefined;
  options: SelectOption[];
  value: string;
  label: string;
  onSelect: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const color = status?.color ?? "var(--text2)";
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex h-9 w-fit items-center gap-2 rounded-[6px] px-3 text-[13px] font-bold uppercase tracking-[0.03em] transition-[filter] hover:brightness-95"
        style={{ color, backgroundColor: `color-mix(in srgb, ${color} 16%, var(--surface))` }}
      >
        {status?.name ?? "—"}
        <ChevronDown size={15} strokeWidth={2.5} />
      </button>
      <SelectMenu open={open} onClose={() => setOpen(false)} anchorRef={ref} width={240} options={options} value={value} onSelect={(v) => v !== value && onSelect(v)} />
    </>
  );
}

/**
 * Click-to-edit description: rendered rich text, click anywhere to switch to
 * the editor. AI draft streams into a plain buffer and loads into the
 * editor when finished (LiteEditor only reads initialContent at mount).
 */
function DescriptionEditor({
  issueId,
  issueTitle,
  descriptionJson,
  onSaved,
}: {
  issueId: string;
  issueTitle: string;
  descriptionJson: unknown;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation("issue");
  const hasDescription = normalizeToBlocks(descriptionJson) !== undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Block[]>([]);
  const [initial, setInitial] = useState<PartialBlock[] | undefined>(undefined);
  const [editorKey, setEditorKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEditing() {
    const blocks = normalizeToBlocks(descriptionJson) ?? [];
    setInitial(blocks);
    setDraft(blocks as Block[]);
    setEditorKey((k) => k + 1);
    setError(null);
    setEditing(true);
  }

  async function saveDescription() {
    setSaving(true);
    setError(null);
    try {
      const empty = draft.length === 0 || (draft.length === 1 && draft[0]!.type === "paragraph" && (!Array.isArray(draft[0]!.content) || draft[0]!.content.length === 0));
      await updateIssueDescriptionFn({ data: { issueId, descriptionJson: empty ? null : (draft as unknown as Record<string, unknown>[]) } });
      await onSaved();
      setEditing(false);
    } catch (err) {
      setError(t("saveFailed", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSaving(false);
    }
  }

  async function aiDraft() {
    setAiBusy(true);
    let accumulated = "";
    try {
      await streamAiCompletion({ feature: "issue-description", title: issueTitle }, (delta) => {
        accumulated += delta;
      });
    } catch (err) {
      accumulated = err instanceof Error ? t("aiDraftFailed", { message: err.message }) : t("aiDraftFailedGeneric");
    } finally {
      const blocks: PartialBlock[] = accumulated ? [{ type: "paragraph", content: [{ type: "text", text: accumulated, styles: {} }] }] : [];
      setInitial(blocks);
      setDraft(blocks as Block[]);
      setEditorKey((k) => k + 1);
      setAiBusy(false);
    }
  }

  if (editing) {
    return (
      <div
        className="flex flex-col gap-2"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            saveDescription();
          }
        }}
      >
        <ClientOnly fallback={<div className="min-h-[160px] rounded-[6px] border border-border-2 bg-surface" />}>
          <LiteEditor
            key={editorKey}
            initialContent={initial}
            onChange={setDraft}
            autoFocus
            placeholder={t("descriptionPlaceholder")}
            className="min-h-[160px] rounded-[6px] border border-accent bg-surface px-3 py-2 shadow-[0_0_0_3px_var(--accent-soft)]"
          />
        </ClientOnly>
        {error && <p className="text-[13px] text-danger">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" onClick={saveDescription} disabled={saving}>
            {saving ? t("savingEllipsis") : t("save")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
            {t("cancel")}
          </Button>
          <Button variant="subtle" size="sm" onClick={aiDraft} disabled={aiBusy} className="ml-auto">
            <Sparkles size={14} />
            {aiBusy ? t("aiDraftingEllipsis") : t("aiDraftButton")}
          </Button>
        </div>
      </div>
    );
  }

  if (!hasDescription) {
    return (
      <button
        type="button"
        onClick={startEditing}
        className="-mx-2 flex min-h-10 w-[calc(100%+16px)] items-center rounded-[6px] px-2 text-left text-[14px] text-text-3 hover:bg-surface-3"
      >
        {t("addDescription")}
      </button>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      title={t("clickToEdit")}
      onClick={(e) => {
        // Let links (mentions) inside the description work.
        if ((e.target as HTMLElement).closest("a")) return;
        startEditing();
      }}
      onKeyDown={(e) => e.key === "Enter" && startEditing()}
      className="-mx-2 cursor-text rounded-[6px] px-2 py-1 hover:bg-surface-2"
    >
      <ClientOnly fallback={<div className="min-h-[24px]" />}>
        <RichTextView content={descriptionJson} className="text-text" />
      </ClientOnly>
    </div>
  );
}

type PropertyDefinition = IssueData["propertyDefinitions"][number];

function CustomPropertyRow({
  def,
  value,
  members,
  onChange,
}: {
  def: PropertyDefinition;
  value: unknown;
  members: { userId: string; name: string }[];
  onChange: (value: string | number | boolean | string[] | null) => void;
}) {
  const { t } = useTranslation("issue");
  const options = (def.options as { value: string; label: string }[] | null) ?? [];

  if (def.type === "checkbox") {
    return (
      <DetailRow label={def.name}>
        <label className="flex min-h-8 cursor-pointer items-center gap-2 px-2 text-[14px]">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />
          <span className="text-text-2">{value ? t("yes") : t("no")}</span>
        </label>
      </DetailRow>
    );
  }

  if (def.type === "select") {
    const current = options.find((o) => o.value === value);
    return (
      <DetailRow label={def.name}>
        <InlinePicker
          ariaLabel={def.name}
          options={[{ value: "", label: t("none") }, ...options]}
          value={(value as string) ?? ""}
          onSelect={(v) => onChange(v || null)}
          display={current ? <span className="truncate">{current.label}</span> : <EmptyValue>{t("none")}</EmptyValue>}
        />
      </DetailRow>
    );
  }

  if (def.type === "multiSelect") {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <DetailRow label={def.name} align="start">
        <InlineMultiPicker
          ariaLabel={def.name}
          options={options}
          values={selected}
          onChange={(v) => onChange(v)}
          display={
            selected.length ? (
              selected.map((v) => (
                <span key={v} className="inline-flex h-6 items-center rounded-[4px] bg-indigo-soft px-1.5 text-[12.5px] font-medium text-indigo">
                  {options.find((o) => o.value === v)?.label ?? v}
                </span>
              ))
            ) : (
              <EmptyValue>{t("none")}</EmptyValue>
            )
          }
        />
      </DetailRow>
    );
  }

  if (def.type === "person") {
    const person = members.find((m) => m.userId === value);
    return (
      <DetailRow label={def.name}>
        <InlinePicker
          ariaLabel={def.name}
          options={[{ value: "", label: t("none") }, ...members.map((m) => ({ value: m.userId, label: m.name, icon: <Avatar name={m.name} size={20} /> }))]}
          value={(value as string) ?? ""}
          onSelect={(v) => onChange(v || null)}
          display={
            person ? (
              <>
                <Avatar name={person.name} size={22} />
                <span className="truncate">{person.name}</span>
              </>
            ) : typeof value === "string" && value ? (
              <span className="truncate">{value}</span>
            ) : (
              <EmptyValue>{t("none")}</EmptyValue>
            )
          }
        />
      </DetailRow>
    );
  }

  if (def.type === "date") {
    return (
      <DetailRow label={def.name}>
        <InlineDate ariaLabel={def.name} value={typeof value === "string" ? value.slice(0, 10) : ""} onCommit={(v) => onChange(v)} />
      </DetailRow>
    );
  }

  if (def.type === "number") {
    return (
      <DetailRow label={def.name}>
        <InlineInput
          type="number"
          ariaLabel={def.name}
          placeholder={t("none")}
          value={typeof value === "number" ? String(value) : ""}
          onCommit={(v) => {
            if (v === "") return onChange(null);
            const n = Number(v);
            if (!Number.isNaN(n)) onChange(n);
          }}
        />
      </DetailRow>
    );
  }

  // text, textarea, url
  return (
    <DetailRow label={def.name}>
      <InlineInput
        type={def.type === "url" ? "url" : "text"}
        ariaLabel={def.name}
        placeholder={t("none")}
        value={typeof value === "string" ? value : ""}
        onCommit={(v) => onChange(v || null)}
      />
    </DetailRow>
  );
}
