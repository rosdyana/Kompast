import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import type { getProjectBoardFn } from "@/lib/server-fns/projects";
import { listWorkflowStatusesFn } from "@/lib/server-fns/board-columns";
import { getCreateIssueContextFn } from "@/lib/server-fns/issues";

export type BoardData = Awaited<ReturnType<typeof getProjectBoardFn>>;
export type BoardIssue = BoardData["columns"][number]["issues"][number];
export type WorkflowStatus = Awaited<ReturnType<typeof listWorkflowStatusesFn>>[number];
export type ProjectMember = Awaited<ReturnType<typeof getCreateIssueContextFn>>["members"][number];

export const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };

export function useIntlLocale() {
  const { i18n } = useTranslation();
  return INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
}

export function formatShortDate(value: Date | string | null | undefined, locale: string) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { day: "numeric", month: "short" });
}

/** Whole days from now until `end` (negative once past). */
export function daysUntil(end: Date | string) {
  const ms = new Date(end).getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}

/**
 * Lookups every tracking view needs beyond getProjectBoardFn: the
 * project's workflow statuses (name/color/category — the board data only
 * carries column names) and the workspace member list (the board's own
 * `users` only covers assignees of issues currently on the board).
 */
export function useProjectLookups(projectId: string) {
  const [statuses, setStatuses] = useState<WorkflowStatus[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listWorkflowStatusesFn({ data: projectId }).then((s) => !cancelled && setStatuses(s)).catch(() => {});
    getCreateIssueContextFn({ data: projectId })
      .then((c) => {
        if (cancelled) return;
        setMembers(c.members);
        setCurrentUserId(c.currentUserId);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return useMemo(
    () => ({
      statuses,
      statusesById: new Map(statuses.map((s) => [s.id, s])),
      members,
      membersById: new Map(members.map((m) => [m.userId, m])),
      currentUserId,
    }),
    [statuses, members, currentUserId],
  );
}

/**
 * Releasing a pointer drag leaves a trailing native click on the dragged
 * element. dnd-kit swallows it with a document-capture stopPropagation, but a
 * cancelled-propagation click still runs its default action — so a dragged
 * <a href> would navigate. Capturing on `window` runs ahead of dnd-kit's
 * document listener and can still cancel the default. Call `arm()` from
 * onDragStart (the sensor's activation distance means that only fires for
 * a real drag); every fresh pointerdown disarms it.
 */
export function useSuppressClickAfterDrag() {
  const armed = useRef(false);
  useEffect(() => {
    function disarm() {
      armed.current = false;
    }
    function cancel(e: Event) {
      if (!armed.current) return;
      armed.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
    window.addEventListener("pointerdown", disarm, true);
    window.addEventListener("click", cancel, true);
    return () => {
      window.removeEventListener("pointerdown", disarm, true);
      window.removeEventListener("click", cancel, true);
    };
  }, []);
  return { arm: () => (armed.current = true) };
}
