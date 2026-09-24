import { cn } from "@/lib/cn";
import { useEffect, useRef, useState } from "react";
import { ClientOnly, useLoaderData } from "@tanstack/react-router";
import { ChevronDown, Mail, Sparkles, X } from "lucide-react";
import { Button, IconButton } from "@kompast/ui/Button";
import { Badge } from "@kompast/ui/Badge";
import { Tabs } from "@kompast/ui/Tabs";
import { Dialog } from "@kompast/ui/Dialog";
import { FormField, TextArea, TextField } from "@kompast/ui/Input";
import { SelectMenu } from "@kompast/ui/SelectMenu";
import { SkeletonRows } from "@kompast/ui/EmptyState";
import { useTranslation } from "@kompast/i18n";
import { listSprintsFn, getSprintDetailFn, sendSprintSummaryEmailFn } from "@/lib/server-fns/sprints";
import { getPageEditorAccessFn } from "@/lib/server-fns/pages";
import { streamAiCompletion } from "@/lib/ai-stream-client";
import { DocEditor } from "@/components/docs/Editor";
import { TableView } from "./TableView";
import { formatShortDate, useIntlLocale, type BoardData } from "./project-shared";

/**
 * Reuses TableView verbatim (grouping/sort/filter/drag-reorder, the same
 * project-level saved-view config) filtered to this sprint's issues. Each
 * issue carries its sprint-scoped manual rank (sprint_issue.rank) so the
 * "Manual order" sort/drag uses it instead of the global issue.rank.
 */
function SprintReviewTable({
  boardData,
  sprintId,
  sprintIssues,
  onReordered,
}: {
  boardData: BoardData;
  sprintId: string;
  sprintIssues: { id: string; sprintRank: string | null }[];
  onReordered: () => void;
}) {
  const sprintRankByIssueId = new Map(sprintIssues.map((i) => [i.id, i.sprintRank]));
  const filtered: BoardData = {
    ...boardData,
    columns: boardData.columns.map((c) => ({
      ...c,
      issues: c.issues.filter((i) => sprintRankByIssueId.has(i.id)).map((i) => ({ ...i, sprintRank: sprintRankByIssueId.get(i.id) ?? null })),
    })),
  };
  return <TableView data={filtered} sprintContext={{ sprintId, onReordered }} />;
}

type SubTabKey = "review" | "action" | "retro";
type Sprint = Awaited<ReturnType<typeof listSprintsFn>>[number];

function LinkedDoc({ pageId, unavailable }: { pageId: string | null | undefined; unavailable: string }) {
  const shell = useLoaderData({ from: "/_app" });
  const [access, setAccess] = useState<Awaited<ReturnType<typeof getPageEditorAccessFn>> | null>(null);
  useEffect(() => {
    setAccess(null);
    if (!pageId) return;
    getPageEditorAccessFn({ data: pageId }).then(setAccess).catch(() => setAccess(null));
  }, [pageId]);
  if (pageId === null) return <p className="p-6 type-body text-text-3">{unavailable}</p>;
  if (!access) return <SkeletonRows rows={4} className="p-6" />;
  return (
    <ClientOnly fallback={<div className="min-h-[40vh]" />}>
      <div className="px-4 py-3">
        <DocEditor pageId={access.page.id} collabToken={access.collabToken} collabWsUrl={access.collabWsUrl} canEdit={access.canEdit} userId={shell.user.id} userName={shell.user.name} />
      </div>
    </ClientOnly>
  );
}

export function SprintHub({ boardId, data }: { boardId: string; data: BoardData }) {
  const { t } = useTranslation("board");
  const locale = useIntlLocale();
  const [sprints, setSprints] = useState<Sprint[] | null>(null);
  const [selectedSprintId, setSelectedSprintId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getSprintDetailFn>> | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<SubTabKey>("review");
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLButtonElement>(null);

  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailRecipients, setEmailRecipients] = useState<string[]>([]);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [emailSending, setEmailSending] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSentMessage, setEmailSentMessage] = useState<string | null>(null);

  useEffect(() => {
    listSprintsFn({ data: boardId }).then((list) => {
      setSprints(list);
      const active = list.find((s) => s.state === "active");
      setSelectedSprintId((current) => current ?? active?.id ?? list[0]?.id ?? null);
    });
  }, [boardId]);

  async function refreshDetail(sprintId: string) {
    setDetail(await getSprintDetailFn({ data: sprintId }));
  }

  useEffect(() => {
    setDetail(null);
    setAiSummary(null);
    setAiError(null);
    if (selectedSprintId) refreshDetail(selectedSprintId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSprintId]);

  async function generateAiSummary(sprintId: string) {
    setAiBusy(true);
    setAiError(null);
    setAiSummary("");
    try {
      await streamAiCompletion({ feature: "sprint-summary", sprintId }, (delta) => setAiSummary((prev) => (prev ?? "") + delta));
    } catch (err) {
      setAiError(err instanceof Error ? err.message : t("sprint.aiSummaryFailed"));
    } finally {
      setAiBusy(false);
    }
  }

  function openEmail() {
    const sprint = sprints?.find((s) => s.id === selectedSprintId);
    setEmailRecipients(data.projectMembers.map((m) => m.email));
    setEmailSubject(sprint ? `${data.project.name} — ${sprint.name} Summary` : `${data.project.name} — Sprint Summary`);
    setEmailBody(aiSummary ?? "");
    setEmailError(null);
    setEmailSentMessage(null);
    setEmailOpen(true);
  }

  async function sendEmail() {
    if (!selectedSprintId || emailRecipients.length === 0) return;
    setEmailSending(true);
    setEmailError(null);
    try {
      const result = await sendSprintSummaryEmailFn({ data: { sprintId: selectedSprintId, recipients: emailRecipients, subject: emailSubject, body: emailBody } });
      setEmailSentMessage(t("sprint.emailSentConfirmation", { count: result.sent }));
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : t("sprint.emailSendFailed"));
    } finally {
      setEmailSending(false);
    }
  }

  if (sprints === null) return <SkeletonRows rows={5} className="p-6" />;
  if (sprints.length === 0) return <div className="px-4 py-4 sm:px-6"><TableView data={data} /></div>;

  const selected = sprints.find((s) => s.id === selectedSprintId);
  const stateLabel = (s: Sprint) => (s.state === "active" ? t("sprint.stateActive") : s.state === "future" ? t("sprint.stateFuture") : t("sprint.stateClosed"));
  const stateTone = (s: Sprint) => (s.state === "active" ? "accent" : s.state === "closed" ? "green" : "neutral") as "accent" | "green" | "neutral";

  return (
    <div className="flex flex-col gap-4 px-4 pb-12 pt-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button ref={pickerRef} variant="outline" onClick={() => setPickerOpen(!pickerOpen)} aria-haspopup="listbox">
          <span className="font-semibold">{selected?.name ?? t("sprint.selectPlaceholder")}</span>
          {selected && <Badge tone={stateTone(selected)}>{stateLabel(selected)}</Badge>}
          <ChevronDown size={14} className="text-text-3" />
        </Button>
        <SelectMenu
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          anchorRef={pickerRef}
          width={280}
          options={sprints.map((s) => ({
            value: s.id,
            label: s.name,
            hint: `${stateLabel(s)}${s.startAt ? ` · ${formatShortDate(s.startAt, locale)}` : ""}`,
          }))}
          value={selectedSprintId}
          onSelect={(v) => setSelectedSprintId(v)}
        />
        {selected && (selected.startAt || selected.endAt) && (
          <span className="type-small text-text-3">
            {formatShortDate(selected.startAt, locale) ?? "?"} – {formatShortDate(selected.endAt, locale) ?? "?"}
          </span>
        )}
        {detail && (
          <span className="type-small text-text-2">
            · {detail.report.completedIssueCount}/{detail.report.scopeIssueCount} {t("sprint.issuesUnit")} · {detail.report.completedPoints}/{detail.report.scopePoints} {t("sprint.pointsUnit")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => selectedSprintId && generateAiSummary(selectedSprintId)} disabled={aiBusy || !selectedSprintId}>
            <Sparkles size={14} className="text-violet" />
            {aiBusy ? t("sprint.writingEllipsis") : t("sprint.generateSummary")}
          </Button>
          {aiSummary !== null && !aiError && !aiBusy && (
            <Button variant="outline" size="sm" onClick={openEmail}>
              <Mail size={14} />
              {t("sprint.sendByEmailButton")}
            </Button>
          )}
        </div>
      </div>

      {(aiSummary !== null || aiError) && (
        <div className="rounded-[10px] border border-border bg-surface-2 px-4 py-3">
          <div className="mb-1.5 flex items-center gap-2">
            <Sparkles size={14} className="text-violet" />
            <span className="text-[13.5px] font-semibold">{t("sprint.aiSummaryHeading")}</span>
            <IconButton size="xs" className="ml-auto" aria-label="Close" onClick={() => { setAiSummary(null); setAiError(null); }}>
              <X size={13} />
            </IconButton>
          </div>
          {aiError ? <p className="type-small text-danger">{aiError}</p> : <p className="whitespace-pre-wrap type-body text-text-2">{aiSummary || "…"}</p>}
        </div>
      )}

      <Tabs
        variant="pill"
        items={[
          { key: "review", label: t("sprint.reviewHeading") },
          { key: "action", label: t("sprint.actionHeading") },
          { key: "retro", label: t("sprint.retrospectiveHeading") },
        ]}
        active={activeSubTab}
        onChange={(k) => setActiveSubTab(k as SubTabKey)}
      />

      {/* The review table draws its own frame; only the linked docs need one here. */}
      <div className={cn("min-w-0", activeSubTab !== "review" && "rounded-[10px] border border-border bg-surface")}>
        {activeSubTab === "review" &&
          (detail ? (
            <SprintReviewTable
              boardData={data}
              sprintId={selectedSprintId!}
              sprintIssues={detail.issues.map((i) => ({ id: i.id, sprintRank: i.sprintRank ?? null }))}
              onReordered={() => refreshDetail(selectedSprintId!)}
            />
          ) : (
            <SkeletonRows rows={5} className="p-4" />
          ))}
        {activeSubTab === "action" && <LinkedDoc pageId={detail ? detail.minutesPageId : undefined} unavailable={t("sprint.actionUnavailable")} />}
        {activeSubTab === "retro" && <LinkedDoc pageId={detail ? detail.retroPageId : undefined} unavailable={t("sprint.retrospectiveUnavailable")} />}
      </div>

      <Dialog
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        title={t("sprint.emailModalHeading")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEmailOpen(false)}>
              {t("cancel")}
            </Button>
            <Button variant="primary" onClick={sendEmail} disabled={emailSending || emailRecipients.length === 0}>
              {emailSending ? t("sprint.emailSendingEllipsis") : t("sprint.emailSendButton")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3.5">
          <FormField label={t("sprint.emailToLabel")}>
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-[6px] border border-border-2 p-2">
              {data.projectMembers.map((m) => (
                <label key={m.id} className="flex items-center gap-2 rounded-[4px] px-1 py-0.5 text-[13.5px] hover:bg-surface-2">
                  <input
                    type="checkbox"
                    checked={emailRecipients.includes(m.email)}
                    onChange={(e) => setEmailRecipients((prev) => (e.target.checked ? [...prev, m.email] : prev.filter((r) => r !== m.email)))}
                  />
                  {m.name} <span className="truncate text-text-3">{m.email}</span>
                </label>
              ))}
              {data.projectMembers.length === 0 && <p className="type-small text-text-3">{t("sprint.emailNoRecipientsHint")}</p>}
            </div>
          </FormField>
          <FormField label={t("sprint.emailSubjectLabel")} htmlFor="sprint-email-subject">
            <TextField id="sprint-email-subject" value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} />
          </FormField>
          <FormField label={t("sprint.emailBodyLabel")} htmlFor="sprint-email-body">
            <TextArea id="sprint-email-body" rows={8} value={emailBody} onChange={(e) => setEmailBody(e.target.value)} />
          </FormField>
          {emailError && <p className="type-small text-danger">{emailError}</p>}
          {emailSentMessage && <p className="type-small text-green">{emailSentMessage}</p>}
        </div>
      </Dialog>
    </div>
  );
}
