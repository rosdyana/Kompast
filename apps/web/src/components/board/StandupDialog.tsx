import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { Check, ChevronLeft, ChevronRight, MessageSquare, Pause, Play, Settings, Shuffle, SkipForward } from "lucide-react";
import { Dialog } from "@kompast/ui/Dialog";
import { Avatar } from "@kompast/ui/Avatar";
import { Button, IconButton } from "@kompast/ui/Button";
import { NativeSelect, TextArea } from "@kompast/ui/Input";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation } from "@kompast/i18n";
import { cn } from "@/lib/cn";
import { useClientNow } from "@/lib/use-client-now";
import { finishStandupFn, getStandupDigestFn } from "@/lib/server-fns/standup";
import { useIntlLocale, type BoardData, type BoardIssue } from "./project-shared";
import { formatClock, localDateKey, previousWorkingDayStart } from "./standup-time";

type DigestByUser = Awaited<ReturnType<typeof getStandupDigestFn>>["byUser"];
type DigestItem = DigestByUser[string][number];
type MemberStatus = "pending" | "done" | "skipped";

interface MemberDraft {
  blockers: string;
  notes: string;
  status: MemberStatus;
}

interface TimerState {
  running: boolean;
  /** Date.now() when the current running segment began. Only meaningful while `running`. */
  segmentStart: number;
  /** Committed total meeting time, excluding the running segment. */
  totalMs: number;
  /** Committed per-person time, excluding the running segment. */
  perPerson: Record<string, number>;
}

interface StandupDraft {
  order: string[];
  currentId: string | null;
  members: Record<string, MemberDraft>;
  timeboxMin: number;
  targetMin: number;
  timer: { totalMs: number; perPerson: Record<string, number> };
}

const TIMEBOX_OPTIONS = [1, 2, 3];
const TARGET_OPTIONS = [10, 15, 20];
const DEFAULT_TIMEBOX_MIN = 2;
const DEFAULT_TARGET_MIN = 15;
/** Amber threshold for the per-person clock, as a fraction of the timebox. */
const WARN_FRACTION = 0.8;
const EMPTY_MEMBER: MemberDraft = { blockers: "", notes: "", status: "pending" };

function draftKeyFor(sprintId: string, date: string) {
  return `standup:${sprintId}:${date}`;
}

function readDraft(key: string): StandupDraft | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StandupDraft;
    if (!parsed || !Array.isArray(parsed.order) || typeof parsed.members !== "object" || !parsed.timer) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDraft(key: string, draft: StandupDraft) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Storage full or disabled: the standup still works, it just can't resume after a reload.
  }
}

function clearDraft(key: string) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/** Keeps the saved order for people still on the roster and appends anyone new. */
function reconcileOrder(prev: string[], roster: string[]): string[] {
  const inRoster = new Set(roster);
  const kept = prev.filter((id) => inRoster.has(id));
  const keptSet = new Set(kept);
  return [...kept, ...roster.filter((id) => !keptSet.has(id))];
}

function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Folds the running segment into the committed totals. Called before any
 * change of speaker or a pause, so elapsed time is always derived from
 * timestamps and never from counted ticks (background tabs throttle intervals).
 */
function commitTimer(t: TimerState, now: number, currentId: string | null): TimerState {
  if (!t.running) return t;
  const delta = Math.max(0, now - t.segmentStart);
  return {
    ...t,
    segmentStart: now,
    totalMs: t.totalMs + delta,
    perPerson: currentId ? { ...t.perPerson, [currentId]: (t.perPerson[currentId] ?? 0) + delta } : t.perPerson,
  };
}

function categoryRank(category: string | undefined): number {
  if (category === "in_progress") return 0;
  if (category === "todo") return 1;
  return 2;
}

export function StandupDialog({
  data,
  sprintId,
  teamId,
  statusesById,
  onClose,
}: {
  data: BoardData;
  sprintId: string;
  teamId: string;
  statusesById: Map<string, { name: string; category: string }>;
  onClose: () => void;
}) {
  const { t } = useTranslation("board");
  const router = useRouter();
  const toast = useToast();
  const locale = useIntlLocale();
  // Null until mounted on the client. The dialog is only mounted after the button click, so this is at most one render late.
  const now = useClientNow();
  const projectKey = data.project.key;

  const allBoardIssues = useMemo(() => data.columns.flatMap((c) => c.issues), [data.columns]);
  const issuesById = useMemo(() => new Map(allBoardIssues.map((i) => [i.id, i])), [allBoardIssues]);
  const sprintIssues = useMemo(() => {
    const activeIds = new Set(data.activeSprintIssueIds);
    return allBoardIssues.filter((i) => activeIds.has(i.id));
  }, [allBoardIssues, data.activeSprintIssueIds]);

  const namesById = useMemo(() => {
    const names = new Map<string, string>();
    for (const m of data.projectMembers) names.set(m.id, m.name);
    for (const m of data.orgMembers) names.set(m.userId, m.name);
    for (const u of data.users) names.set(u.id, u.name);
    return names;
  }, [data.projectMembers, data.orgMembers, data.users]);
  const nameOf = (id: string) => namesById.get(id) ?? id;

  // "Since" is the previous working day's local midnight; it's also the digest window.
  const since = now ? previousWorkingDayStart(now) : null;
  const sinceIso = since?.toISOString() ?? null;
  const sinceWhen = since ? since.toLocaleDateString(locale, { weekday: "long" }) : "";

  const [digest, setDigest] = useState<DigestByUser | null>(null);
  const [digestFailed, setDigestFailed] = useState(false);
  useEffect(() => {
    if (!sinceIso) return;
    let cancelled = false;
    getStandupDigestFn({ data: { sprintId, since: sinceIso } })
      .then((res) => {
        if (!cancelled) setDigest(res.byUser);
      })
      .catch(() => {
        if (!cancelled) setDigestFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sprintId, sinceIso]);

  const rosterIds = useMemo(() => {
    const ids = new Set(sprintIssues.map((i) => i.assigneeId).filter((x): x is string => !!x));
    for (const uid of Object.keys(digest ?? {})) ids.add(uid);
    return [...ids].sort((a, b) => (namesById.get(a) ?? a).localeCompare(namesById.get(b) ?? b));
  }, [sprintIssues, digest, namesById]);

  const draftKey = now ? draftKeyFor(sprintId, localDateKey(now)) : null;
  const [draftReady, setDraftReady] = useState(false);
  const [order, setOrder] = useState<string[]>([]);
  const [currentPick, setCurrentPick] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, MemberDraft>>({});
  const [timeboxMin, setTimeboxMin] = useState(DEFAULT_TIMEBOX_MIN);
  const [targetMin, setTargetMin] = useState(DEFAULT_TARGET_MIN);
  // Starts paused, so "timer has started" is a real signal for the close-confirm.
  const [timer, setTimer] = useState<TimerState>({ running: false, segmentStart: 0, totalMs: 0, perPerson: {} });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const finishedRef = useRef(false);
  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  // Restore a draft from this tab's sessionStorage once the date (and so the key) is known.
  useEffect(() => {
    if (!draftKey || draftReady) return;
    const draft = readDraft(draftKey);
    if (draft) {
      setOrder(draft.order);
      setCurrentPick(draft.currentId);
      setMembers(draft.members);
      setTimeboxMin(draft.timeboxMin);
      setTargetMin(draft.targetMin);
      // A restored timer always comes back paused, so a reload never keeps running unattended.
      setTimer({ running: false, segmentStart: 0, totalMs: draft.timer.totalMs, perPerson: draft.timer.perPerson });
    }
    setDraftReady(true);
  }, [draftKey, draftReady]);

  useEffect(() => {
    setOrder((prev) => reconcileOrder(prev, rosterIds));
  }, [rosterIds, draftReady]);

  const currentId = currentPick && order.includes(currentPick) ? currentPick : (order[0] ?? null);
  const currentIndex = currentId ? order.indexOf(currentId) : -1;
  const memberOf = (id: string): MemberDraft => members[id] ?? EMPTY_MEMBER;

  // The 250ms tick only forces a re-render; the displayed numbers come from Date.now() and the stored segment start.
  useEffect(() => {
    if (!timer.running) return;
    const handle = window.setInterval(forceRender, 250);
    return () => window.clearInterval(handle);
  }, [timer.running]);

  // Persist the draft. A running segment is folded in so a saved snapshot never loses time.
  // While running, the 250ms re-render bumps this every 5s, so a reload loses at most ~5s.
  const persistTick = timer.running ? Math.floor(Date.now() / 5000) : 0;
  useEffect(() => {
    if (!draftKey || !draftReady || finishedRef.current) return;
    const snap = commitTimer(timer, Date.now(), currentId);
    writeDraft(draftKey, {
      order,
      currentId,
      members,
      timeboxMin,
      targetMin,
      timer: { totalMs: snap.totalMs, perPerson: snap.perPerson },
    });
  }, [draftKey, draftReady, order, currentId, members, timeboxMin, targetMin, timer, persistTick]);

  const nowMs = Date.now();
  const totalMs = timer.totalMs + (timer.running ? nowMs - timer.segmentStart : 0);
  const personMs = (id: string) => (timer.perPerson[id] ?? 0) + (timer.running && id === currentId ? nowMs - timer.segmentStart : 0);
  const timeboxMs = timeboxMin * 60_000;
  const targetMs = targetMin * 60_000;
  const currentMs = currentId ? personMs(currentId) : 0;
  const currentOver = currentMs > timeboxMs;
  const currentWarn = !currentOver && currentMs >= timeboxMs * WARN_FRACTION;
  const totalOver = totalMs > targetMs;
  const totalWarn = !totalOver && totalMs >= targetMs * WARN_FRACTION;

  const dirty = timer.running || timer.totalMs > 0 || Object.values(members).some((m) => m.blockers.trim() || m.notes.trim() || m.status !== "pending");

  function requestClose() {
    if (dirty && !window.confirm(t("standup.confirmClose"))) return;
    onClose();
  }

  function switchTo(id: string) {
    setTimer((tm) => commitTimer(tm, Date.now(), currentId));
    setCurrentPick(id);
  }

  function go(delta: 1 | -1) {
    const next = order[currentIndex + delta];
    if (currentIndex < 0 || !next) return;
    // Moving forward past someone marks them done. Going back leaves their status alone.
    if (delta === 1 && currentId && memberOf(currentId).status === "pending") patchMember(currentId, { status: "done" });
    switchTo(next);
  }

  function patchMember(id: string, patch: Partial<MemberDraft>) {
    setMembers((m) => ({ ...m, [id]: { ...(m[id] ?? EMPTY_MEMBER), ...patch } }));
  }

  function skipCurrent() {
    if (!currentId) return;
    const status = memberOf(currentId).status;
    if (status === "skipped") {
      patchMember(currentId, { status: "pending" });
      return;
    }
    patchMember(currentId, { status: "skipped" });
    const next = order[currentIndex + 1];
    if (next) switchTo(next);
  }

  function togglePause() {
    const at = Date.now();
    setTimer((tm) => (tm.running ? { ...commitTimer(tm, at, currentId), running: false } : { ...tm, running: true, segmentStart: at }));
  }

  // Derived lists for the current person. The "since" list comes from the digest; "today" from the board data already on the client.
  function issueLabel(issueId: string) {
    const issue = issuesById.get(issueId);
    return { key: issue ? `${projectKey}-${issue.keySeq}` : issueId, title: issue?.title ?? "", issue };
  }

  function describeItem(item: DigestItem): string {
    if (item.kind === "status") return `${item.fromStatus?.name ?? "?"} → ${item.toStatus?.name ?? "?"}`;
    if (item.kind === "commented") return t("standup.line.commented", { count: item.commentCount ?? 0 });
    if (item.kind === "edited") return t("standup.line.edited", { fields: (item.fields ?? []).join(", ") });
    return t("standup.line.created");
  }

  function todayIssues(userId: string): BoardIssue[] {
    return sprintIssues
      .filter((i) => i.assigneeId === userId && (statusesById.get(i.statusId)?.category ?? "todo") !== "done")
      .sort((a, b) => categoryRank(statusesById.get(a.statusId)?.category) - categoryRank(statusesById.get(b.statusId)?.category));
  }

  function didLines(userId: string): string[] {
    return (digest?.[userId] ?? []).map((item) => {
      const { key, title } = issueLabel(item.issueId);
      return `${key}${title ? ` ${title}` : ""} — ${describeItem(item)}`;
    });
  }

  function todayLines(userId: string): string[] {
    return todayIssues(userId).map((i) => {
      const key = `${projectKey}-${i.keySeq}`;
      return `${key} ${i.title} — ${statusesById.get(i.statusId)?.name ?? "?"}`;
    });
  }

  async function finish() {
    if (!now || saving || order.length === 0) return;
    const date = localDateKey(now);
    const payload = {
      sprintId,
      date,
      durationSec: Math.round(totalMs / 1000),
      members: order.map((id) => {
        const m = memberOf(id);
        // Someone who was discussed counts as covered, including the current speaker. Pending people who were never reached are recorded as skipped.
        const covered = m.status === "done" || (m.status === "pending" && id === currentId);
        return {
          name: nameOf(id),
          did: covered ? didLines(id) : [],
          today: covered ? todayLines(id) : [],
          blockers: m.blockers,
          notes: m.notes,
          skipped: !covered,
        };
      }),
    };

    setSaving(true);
    setSaveError(null);
    try {
      const res = await finishStandupFn({ data: payload });
      finishedRef.current = true;
      if (draftKey) clearDraft(draftKey);
      toast.show({
        tone: "success",
        title: t("standup.savedTitle"),
        description: t("standup.savedDescription", { date }),
        action: {
          label: t("standup.openPage"),
          onClick: () => void router.navigate({ to: "/docs/$pageId", params: { pageId: res.pageId } }),
        },
      });
      onClose();
    } catch {
      setSaveError(t("standup.saveFailed"));
      setSaving(false);
    }
  }

  const currentStatus = currentId ? memberOf(currentId).status : "pending";
  const statusLabel = (id: string) => {
    const status = memberOf(id).status;
    if (status === "done") return t("standup.statusDone");
    if (status === "skipped") return t("standup.statusSkipped");
    return id === currentId ? t("standup.statusCurrent") : t("standup.statusPending");
  };
  const currentDigest = currentId ? (digest?.[currentId] ?? []) : [];

  return (
    <Dialog
      open
      onClose={requestClose}
      size="xl"
      title={t("standup.title")}
      description={now ? t("standup.description", { date: localDateKey(now) }) : undefined}
      footer={
        <div className="flex w-full items-center justify-end gap-3">
          {saveError && <span className="mr-auto type-small text-danger">{saveError}</span>}
          <Button variant="primary" onClick={finish} disabled={saving || !now || order.length === 0}>
            {saving ? t("standup.saving") : t("standup.finish")}
          </Button>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden md:flex-row">
        <aside className="flex min-h-0 flex-col gap-1 md:w-[230px] md:flex-none">
          <div className="flex items-center justify-between gap-2 pb-1">
            <span className="type-small font-semibold text-text-2">{t("standup.team")}</span>
            <Button variant="ghost" size="xs" onClick={() => setOrder((o) => shuffled(o))} disabled={order.length < 2}>
              <Shuffle size={13} />
              {t("standup.shuffle")}
            </Button>
          </div>
          <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
            {order.map((id) => {
              const isCurrent = id === currentId;
              const status = memberOf(id).status;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => switchTo(id)}
                  aria-current={isCurrent}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left",
                    isCurrent ? "bg-surface-3" : "hover:bg-surface-2",
                    status === "skipped" && "opacity-60",
                  )}
                >
                  <Avatar name={nameOf(id)} size={22} />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-text">{nameOf(id)}</span>
                  <span className="flex flex-col items-end leading-tight">
                    <span className="tabular-nums text-[12px] text-text-2">{formatClock(personMs(id))}</span>
                    <span className="text-[11px] text-text-3">
                      {status === "done" && <Check size={11} className="mr-0.5 inline" />}
                      {statusLabel(id)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
          {!currentId ? (
            <p className="type-small text-text-3">{t("standup.noMembers")}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                <div>
                  <p className="type-small text-text-3">{t("standup.timeboxLabel")}</p>
                  <p className={cn("text-[28px] font-semibold leading-none tabular-nums", currentOver ? "text-danger" : currentWarn ? "text-amber" : "text-text")}>
                    {formatClock(currentMs)}
                    {currentOver && <span className="ml-2 text-[15px] font-medium">{t("standup.overBy", { time: formatClock(currentMs - timeboxMs) })}</span>}
                  </p>
                </div>
                <div>
                  <p className="type-small text-text-3">{t("standup.totalLabel")}</p>
                  <p className={cn("text-[20px] font-semibold leading-none tabular-nums", totalOver ? "text-danger" : totalWarn ? "text-amber" : "text-text")}>
                    {formatClock(totalMs)} <span className="text-[14px] font-normal text-text-3">/ {formatClock(targetMs)}</span>
                  </p>
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-1.5">
                  <IconButton aria-label={t("standup.previous")} onClick={() => go(-1)} disabled={currentIndex <= 0}>
                    <ChevronLeft size={16} />
                  </IconButton>
                  <IconButton aria-label={t("standup.next")} onClick={() => go(1)} disabled={currentIndex < 0 || currentIndex >= order.length - 1}>
                    <ChevronRight size={16} />
                  </IconButton>
                  <Button variant="outline" size="sm" onClick={togglePause}>
                    {timer.running ? <Pause size={14} /> : <Play size={14} />}
                    {timer.running ? t("standup.pause") : t("standup.resume")}
                  </Button>
                  <IconButton aria-label={t("standup.timerSettings")} aria-expanded={settingsOpen} onClick={() => setSettingsOpen((o) => !o)}>
                    <Settings size={15} />
                  </IconButton>
                </div>
              </div>

              {settingsOpen && (
                <div className="flex flex-wrap gap-4 rounded-[8px] bg-surface-2 p-3">
                  <label className="flex items-center gap-2 type-small text-text-2">
                    {t("standup.timeboxSetting")}
                    <NativeSelect value={timeboxMin} onChange={(e) => setTimeboxMin(Number(e.target.value))} className="w-auto">
                      {TIMEBOX_OPTIONS.map((m) => (
                        <option key={m} value={m}>
                          {t("standup.minutes", { count: m })}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  <label className="flex items-center gap-2 type-small text-text-2">
                    {t("standup.targetSetting")}
                    <NativeSelect value={targetMin} onChange={(e) => setTargetMin(Number(e.target.value))} className="w-auto">
                      {TARGET_OPTIONS.map((m) => (
                        <option key={m} value={m}>
                          {t("standup.minutes", { count: m })}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 border-b border-border pb-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Avatar name={nameOf(currentId)} size={26} />
                  <span className="truncate text-[16px] font-semibold">{nameOf(currentId)}</span>
                </div>
                {currentStatus !== "done" && (
                  <Button variant="ghost" size="sm" onClick={skipCurrent}>
                    <SkipForward size={14} />
                    {currentStatus === "skipped" ? t("standup.undoSkip") : t("standup.skip")}
                  </Button>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <h3 className="type-small font-semibold text-text-2">{t("standup.since", { when: sinceWhen })}</h3>
                {digestFailed ? (
                  <p className="type-small text-text-3">{t("standup.digestFailed")}</p>
                ) : !digest ? (
                  <p className="type-small text-text-3">{t("loadingEllipsis")}</p>
                ) : currentDigest.length === 0 ? (
                  <p className="type-small text-text-3">{t("standup.noActivity")}</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {currentDigest.map((item, idx) => {
                      const { key, title, issue } = issueLabel(item.issueId);
                      return (
                        <li key={`${item.issueId}-${item.kind}-${idx}`} className="flex flex-wrap items-center gap-2 text-[13.5px]">
                          {issue ? (
                            <Link
                              to="/issues/$teamId/$projectKey/$issueKeySeq"
                              params={{ teamId, projectKey, issueKeySeq: String(issue.keySeq) }}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="min-w-0 truncate hover:underline"
                            >
                              <span className="type-key mr-1.5 text-text-3">{key}</span>
                              {title}
                            </Link>
                          ) : (
                            <span className="text-text-3">{key}</span>
                          )}
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[11.5px] font-medium",
                              item.kind === "status" && item.toStatus?.category === "done" ? "bg-surface-3 text-green" : "bg-surface-3 text-text-2",
                            )}
                          >
                            {item.kind === "commented" && <MessageSquare size={11} />}
                            {describeItem(item)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <h3 className="type-small font-semibold text-text-2">{t("standup.today")}</h3>
                {todayIssues(currentId).length === 0 ? (
                  <p className="type-small text-text-3">{t("standup.noToday")}</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {todayIssues(currentId).map((i) => (
                      <li key={i.id} className="flex flex-wrap items-center gap-2 text-[13.5px]">
                        <Link
                          to="/issues/$teamId/$projectKey/$issueKeySeq"
                          params={{ teamId, projectKey, issueKeySeq: String(i.keySeq) }}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="min-w-0 truncate hover:underline"
                        >
                          <span className="type-key mr-1.5 text-text-3">{`${projectKey}-${i.keySeq}`}</span>
                          {i.title}
                        </Link>
                        <span className="rounded-[4px] bg-surface-3 px-1.5 py-0.5 text-[11.5px] font-medium text-text-2">
                          {statusesById.get(i.statusId)?.name ?? "?"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <label className="flex flex-col gap-1.5">
                <span className="type-small font-semibold text-text-2">{t("standup.blockers")}</span>
                <TextArea
                  rows={3}
                  value={memberOf(currentId).blockers}
                  placeholder={t("standup.blockersPlaceholder")}
                  onChange={(e) => patchMember(currentId, { blockers: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="type-small font-semibold text-text-2">{t("standup.notes")}</span>
                <TextArea
                  rows={2}
                  value={memberOf(currentId).notes}
                  placeholder={t("standup.notesPlaceholder")}
                  onChange={(e) => patchMember(currentId, { notes: e.target.value })}
                />
              </label>
            </>
          )}
        </section>
      </div>
    </Dialog>
  );
}
