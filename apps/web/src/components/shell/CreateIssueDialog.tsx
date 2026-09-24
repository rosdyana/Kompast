import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ClientOnly, useRouter } from "@tanstack/react-router";
import type { Block } from "@blocknote/core";
import { ChevronDown, X } from "lucide-react";
import { Dialog } from "@kompast/ui/Dialog";
import { Button } from "@kompast/ui/Button";
import { Avatar, UnassignedAvatar } from "@kompast/ui/Avatar";
import { IssueTypeIcon } from "@kompast/ui/IssueTypeIcon";
import { PriorityIcon } from "@kompast/ui/PriorityIcon";
import { SelectMenu, type SelectOption } from "@kompast/ui/SelectMenu";
import { SkeletonRows } from "@kompast/ui/EmptyState";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation } from "@kompast/i18n";
import { createIssueFn, getCreateIssueContextFn } from "@/lib/server-fns/issues";
import { LiteEditor } from "@/components/shared/LiteEditor";
import { cn } from "@/lib/cn";
import { ProjectIcon } from "./ProjectIcon";
import type { CreateIssueDefaults } from "./WorkbenchContext";
import type { SidebarShellData } from "./AppSidebar";

type Ctx = Awaited<ReturnType<typeof getCreateIssueContextFn>>;
const LAST_PROJECT_KEY = "kompast-last-create-project";

/** A trigger that looks like a field and opens a SelectMenu. */
function PickerField({
  label,
  display,
  options,
  value,
  onSelect,
  disabled,
  searchPlaceholder,
}: {
  label: string;
  display: ReactNode;
  options: SelectOption[];
  value: string;
  onSelect: (v: string) => void;
  disabled?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-text-2">{label}</span>
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="kp-input flex items-center gap-2 text-left disabled:opacity-60"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{display}</span>
        <ChevronDown size={14} className="flex-none text-text-3" />
      </button>
      <SelectMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        width="anchor"
        options={options}
        value={value}
        onSelect={onSelect}
        searchPlaceholder={searchPlaceholder}
      />
    </div>
  );
}

export function CreateIssueDialog({
  open,
  onClose,
  defaults,
  shell,
}: {
  open: boolean;
  onClose: () => void;
  defaults: CreateIssueDefaults | null;
  shell: SidebarShellData;
}) {
  const { t } = useTranslation(["nav", "common"]);
  const router = useRouter();
  const toast = useToast();

  const [projectId, setProjectId] = useState<string>("");
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const [typeId, setTypeId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState<Block[]>([]);
  const [editorKey, setEditorKey] = useState(0);
  const [assigneeId, setAssigneeId] = useState("");
  const [priority, setPriority] = useState("medium");
  const [sprintId, setSprintId] = useState("");
  const [epicId, setEpicId] = useState("");
  const [points, setPoints] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [labelDraft, setLabelDraft] = useState("");
  const [createAnother, setCreateAnother] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  // Pick the project on open: explicit default > last used > first.
  useEffect(() => {
    if (!open) return;
    let last: string | null = null;
    try {
      last = window.localStorage.getItem(LAST_PROJECT_KEY);
    } catch {
      /* ignore */
    }
    const pick =
      (defaults?.projectId && shell.projects.find((p) => p.id === defaults.projectId)?.id) ||
      (last && shell.projects.find((p) => p.id === last)?.id) ||
      shell.projects[0]?.id ||
      "";
    setProjectId(pick);
    resetFields(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    setCtx(null);
    setCtxError(null);
    getCreateIssueContextFn({ data: projectId })
      .then((c) => {
        if (cancelled) return;
        setCtx(c);
        const standard = c.issueTypes.filter((tp) => !tp.isSubtask && tp.hierarchyLevel !== 0);
        setTypeId(
          (defaults?.typeId && c.issueTypes.find((tp) => tp.id === defaults.typeId)?.id) ||
            standard.find((tp) => tp.name.toLowerCase() === "task")?.id ||
            standard[0]?.id ||
            c.issueTypes[0]?.id ||
            "",
        );
        setPriority(c.priorityLevels.find((p) => p.key === "medium")?.key ?? c.priorityLevels[0]?.key ?? "medium");
        if (defaults?.sprintId && c.sprints.some((s) => s.id === defaults.sprintId)) setSprintId(defaults.sprintId);
        if (defaults?.epicId) setEpicId(defaults.epicId);
      })
      .catch((err) => !cancelled && setCtxError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  function resetFields(full: boolean) {
    setTitle("");
    setDescription([]);
    setEditorKey((k) => k + 1);
    setPoints("");
    setLabels([]);
    setLabelDraft("");
    setError(null);
    setTouched(false);
    if (full) {
      setAssigneeId(defaults?.assigneeId ?? "");
      setSprintId(defaults?.sprintId ?? "");
      setEpicId(defaults?.epicId ?? "");
      setDueDate("");
    }
  }

  const project = shell.projects.find((p) => p.id === projectId);
  const selectedType = ctx?.issueTypes.find((tp) => tp.id === typeId);
  const isEpic = selectedType?.hierarchyLevel === 0;

  const typeOptions = useMemo<SelectOption[]>(
    () => (ctx?.issueTypes ?? []).filter((tp) => !tp.isSubtask || defaults?.parentId).map((tp) => ({ value: tp.id, label: tp.name, icon: <IssueTypeIcon type={tp} size={16} /> })),
    [ctx, defaults?.parentId],
  );
  const memberOptions = useMemo<SelectOption[]>(
    () => [
      { value: "", label: t("createDialog.unassigned"), icon: <UnassignedAvatar size={20} /> },
      ...(ctx?.members ?? []).map((m) => ({ value: m.userId, label: m.name, hint: m.email, icon: <Avatar name={m.name} size={20} /> })),
    ],
    [ctx, t],
  );
  const priorityOptions = useMemo<SelectOption[]>(
    () => (ctx?.priorityLevels ?? []).map((p) => ({ value: p.key, label: p.name, icon: <PriorityIcon priority={p} /> })),
    [ctx],
  );
  const sprintOptions = useMemo<SelectOption[]>(
    () => [
      { value: "", label: t("createDialog.backlog") },
      ...(ctx?.sprints ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.state === "active" ? t("createDialog.activeSprint") : undefined })),
    ],
    [ctx, t],
  );
  const epicOptions = useMemo<SelectOption[]>(
    () => [
      { value: "", label: t("createDialog.noEpic") },
      ...(ctx?.epics ?? []).map((e) => ({ value: e.id, label: e.title, hint: `${ctx?.project.key}-${e.keySeq}`, icon: <IssueTypeIcon type={{ name: "Epic", hierarchyLevel: 0 }} size={16} /> })),
    ],
    [ctx, t],
  );
  const projectOptions = useMemo<SelectOption[]>(
    () => shell.projects.map((p) => ({ value: p.id, label: p.name, hint: p.key, icon: <ProjectIcon projectKey={p.key} size={18} /> })),
    [shell.projects],
  );

  function addLabel() {
    const v = labelDraft.trim().replace(/,$/, "");
    if (v && !labels.includes(v)) setLabels([...labels, v]);
    setLabelDraft("");
  }

  async function submit() {
    setTouched(true);
    if (!title.trim()) {
      titleRef.current?.focus();
      return;
    }
    if (!ctx || !typeId || !project) return;
    setSubmitting(true);
    setError(null);
    try {
      const descriptionHasText = description.some((b) => Array.isArray(b.content) ? b.content.length > 0 : true) && description.length > 0;
      const created = await createIssueFn({
        data: {
          projectId,
          typeId,
          title: title.trim(),
          statusId: defaults?.statusId,
          assigneeId: assigneeId || undefined,
          priority,
          storyPoints: points === "" ? undefined : Number(points),
          dueDate: dueDate ? new Date(dueDate) : undefined,
          labels: labels.length ? labels : undefined,
          descriptionJson: descriptionHasText ? description : undefined,
          epicId: !isEpic && epicId ? epicId : undefined,
          parentId: defaults?.parentId,
          sprintId: sprintId || undefined,
        },
      });
      try {
        window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
      } catch {
        /* ignore */
      }
      const key = `${project.key}-${created.keySeq}`;
      const teamId = project.teamId ?? "none";
      toast.show({
        title: t("createDialog.created", { key }),
        description: title.trim(),
        action: {
          label: t("createDialog.view"),
          onClick: () =>
            router.navigate({
              to: "/issues/$teamId/$projectKey/$issueKeySeq",
              params: { teamId, projectKey: project.key, issueKeySeq: String(created.keySeq) },
            }),
        },
      });
      defaults?.onCreated?.({ ...created, projectKey: project.key });
      await router.invalidate();
      if (createAnother) {
        resetFields(false);
        requestAnimationFrame(() => titleRef.current?.focus());
      } else {
        onClose();
      }
    } catch (err) {
      setError(t("createDialog.failed", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSubmitting(false);
    }
  }

  const titleInvalid = touched && !title.trim();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={t("createDialog.title")}
      closeLabel={t("common:close")}
      footer={
        <>
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-[13.5px] text-text-2">
            <input type="checkbox" checked={createAnother} onChange={(e) => setCreateAnother(e.target.checked)} />
            {t("createDialog.createAnother")}
          </label>
          <Button variant="ghost" onClick={onClose}>
            {t("createDialog.cancel")}
          </Button>
          <Button variant="primary" onClick={submit} disabled={submitting || !ctx}>
            {submitting ? t("createDialog.creating") : t("createDialog.submit")}
          </Button>
        </>
      }
    >
      {shell.projects.length === 0 ? (
        <p className="py-6 text-center text-[14px] text-text-2">{t("createDialog.noProjects")}</p>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <PickerField
              label={t("createDialog.project")}
              options={projectOptions}
              value={projectId}
              onSelect={setProjectId}
              display={
                project && (
                  <>
                    <ProjectIcon projectKey={project.key} size={18} />
                    <span className="truncate">{project.name}</span>
                  </>
                )
              }
            />
            <PickerField
              label={t("createDialog.issueType")}
              options={typeOptions}
              value={typeId}
              onSelect={setTypeId}
              disabled={!ctx}
              display={
                selectedType ? (
                  <>
                    <IssueTypeIcon type={selectedType} size={16} />
                    <span className="truncate">{selectedType.name}</span>
                  </>
                ) : (
                  <span className="text-text-3">…</span>
                )
              }
            />
          </div>

          {ctxError && <p className="rounded-[6px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{ctxError}</p>}

          <div className="flex flex-col gap-1.5">
            <label htmlFor="create-issue-summary" className="text-[13px] font-medium text-text-2">
              {t("createDialog.summary")}
              <span className="ml-0.5 text-danger">*</span>
            </label>
            <input
              id="create-issue-summary"
              ref={titleRef}
              data-autofocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-invalid={titleInvalid}
              placeholder={t("createDialog.summaryPlaceholder")}
              className="kp-input text-[15px]"
              maxLength={255}
            />
            {titleInvalid && <p className="text-[12.5px] text-danger">{t("createDialog.summaryRequired")}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-text-2">{t("createDialog.description")}</span>
            <ClientOnly fallback={<div className="min-h-[110px] rounded-[6px] border border-border-2" />}>
              {open && (
                <LiteEditor
                  key={editorKey}
                  onChange={setDescription}
                  placeholder={t("createDialog.descriptionPlaceholder")}
                  className="min-h-[110px] rounded-[6px] border border-border-2 bg-surface px-3 py-2 transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]"
                />
              )}
            </ClientOnly>
          </div>

          {!ctx && !ctxError ? (
            <SkeletonRows rows={3} />
          ) : ctx ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <PickerField
                  label={t("createDialog.assignee")}
                  options={memberOptions}
                  value={assigneeId}
                  onSelect={setAssigneeId}
                  display={(() => {
                    const m = ctx.members.find((x) => x.userId === assigneeId);
                    return m ? (
                      <>
                        <Avatar name={m.name} size={20} />
                        <span className="truncate">{m.name}</span>
                      </>
                    ) : (
                      <>
                        <UnassignedAvatar size={20} />
                        <span className="truncate text-text-2">{t("createDialog.unassigned")}</span>
                      </>
                    );
                  })()}
                />
                {assigneeId !== ctx.currentUserId && (
                  <button type="button" onClick={() => setAssigneeId(ctx.currentUserId)} className="mt-1 text-[12.5px] font-medium text-accent-text hover:underline">
                    {t("createDialog.assignToMe")}
                  </button>
                )}
              </div>
              <PickerField
                label={t("createDialog.priority")}
                options={priorityOptions}
                value={priority}
                onSelect={setPriority}
                display={(() => {
                  const p = ctx.priorityLevels.find((x) => x.key === priority);
                  return p ? <PriorityIcon priority={p} showLabel /> : null;
                })()}
              />
              {!isEpic && (
                <PickerField
                  label={t("createDialog.sprint")}
                  options={sprintOptions}
                  value={sprintId}
                  onSelect={setSprintId}
                  display={<span className="truncate">{ctx.sprints.find((s) => s.id === sprintId)?.name ?? t("createDialog.backlog")}</span>}
                />
              )}
              {!isEpic && ctx.epics.length > 0 && (
                <PickerField
                  label={t("createDialog.epic")}
                  options={epicOptions}
                  value={epicId}
                  onSelect={setEpicId}
                  display={(() => {
                    const e = ctx.epics.find((x) => x.id === epicId);
                    return e ? (
                      <>
                        <IssueTypeIcon type={{ name: "Epic", hierarchyLevel: 0 }} size={16} />
                        <span className="truncate">{e.title}</span>
                      </>
                    ) : (
                      <span className="text-text-2">{t("createDialog.noEpic")}</span>
                    );
                  })()}
                />
              )}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="create-issue-points" className="text-[13px] font-medium text-text-2">
                  {t("createDialog.storyPoints")}
                </label>
                <input id="create-issue-points" type="number" min={0} step="0.5" value={points} onChange={(e) => setPoints(e.target.value)} className="kp-input" />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="create-issue-due" className="text-[13px] font-medium text-text-2">
                  {t("createDialog.dueDate")}
                </label>
                <input id="create-issue-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="kp-input" />
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <label htmlFor="create-issue-labels" className="text-[13px] font-medium text-text-2">
                  {t("createDialog.labels")}
                </label>
                <div className="kp-input flex min-h-8 flex-wrap items-center gap-1.5 py-1 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
                  {labels.map((l) => (
                    <span key={l} className="inline-flex h-6 items-center gap-1 rounded-[4px] bg-surface-3 pl-2 pr-1 text-[12.5px] text-text">
                      {l}
                      <button type="button" aria-label={`Remove ${l}`} onClick={() => setLabels(labels.filter((x) => x !== l))} className="grid h-4 w-4 place-items-center rounded text-text-3 hover:text-danger">
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                  <input
                    id="create-issue-labels"
                    value={labelDraft}
                    onChange={(e) => setLabelDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        addLabel();
                      } else if (e.key === "Backspace" && !labelDraft && labels.length) {
                        setLabels(labels.slice(0, -1));
                      }
                    }}
                    onBlur={addLabel}
                    placeholder={labels.length ? "" : t("createDialog.labelsPlaceholder")}
                    className={cn("min-w-[120px] flex-1 bg-transparent text-[14px] outline-none")}
                  />
                </div>
              </div>
            </div>
          ) : null}

          {error && <p className="rounded-[6px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
        </form>
      )}
    </Dialog>
  );
}
