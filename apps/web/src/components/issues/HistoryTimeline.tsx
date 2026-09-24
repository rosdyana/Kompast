import type { ReactNode } from "react";
import { Bot } from "lucide-react";
import { Avatar } from "@kompast/ui/Avatar";
import { Badge } from "@kompast/ui/Badge";
import { useTranslation } from "@kompast/i18n";
import { fullDateTime, relativeTime } from "./time";

export interface HistoryEntry {
  id: string;
  field: string;
  fromValue: string | null;
  toValue: string | null;
  origin: string;
  originClient: string | null;
  actorId: string | null;
  createdAt: string | Date;
}

/**
 * Jira-style history: one row per change, actor avatar, "changed the
 * Status" sentence, then the from → to values rendered by the caller
 * (so status values can be lozenges, people avatars, etc.).
 */
export function HistoryTimeline({
  entries,
  actorName,
  renderValue,
  intlLocale,
}: {
  entries: HistoryEntry[];
  actorName: (h: HistoryEntry) => string;
  renderValue: (field: string, raw: string | null) => ReactNode;
  intlLocale: string;
}) {
  const { t } = useTranslation("issue");
  if (entries.length === 0) return <p className="py-2 text-[13.5px] text-text-3">{t("noActivityYet")}</p>;

  function sentence(h: HistoryEntry) {
    if (h.field === "created") return t("historyCreatedIssue");
    if (h.field === "description") return t("historyDescriptionChanged");
    if (h.field === "archived") return h.toValue ? t("historyArchivedIssue") : t("historyRestoredIssue");
    return t("historyChanged", { field: t(`historyField.${h.field}`, { defaultValue: h.field }) });
  }
  const showValues = (h: HistoryEntry) => !["created", "description", "archived"].includes(h.field);

  return (
    <ol className="flex flex-col">
      {entries.map((h, i) => {
        const name = actorName(h);
        const isSystem = h.origin === "automation";
        return (
          <li key={h.id} className="relative flex gap-3 pb-4">
            {i < entries.length - 1 && <span aria-hidden className="absolute bottom-0 left-[13px] top-8 w-px bg-border" />}
            {isSystem ? (
              <span className="grid h-7 w-7 flex-none place-items-center rounded-full bg-violet-soft text-violet">
                <Bot size={15} />
              </span>
            ) : (
              <Avatar name={name} size={28} />
            )}
            <div className="min-w-0 flex-1 pt-1">
              <p className="text-[13.5px] leading-snug text-text-2">
                <span className="font-medium text-text">{name}</span> {sentence(h)}
                <span className="ml-2 text-[12.5px] text-text-3" title={fullDateTime(h.createdAt, intlLocale)}>
                  {relativeTime(h.createdAt, intlLocale)}
                </span>
                {h.origin !== "user" && (
                  <Badge tone={isSystem ? "violet" : "neutral"} className="ml-2 align-[1px]">
                    {t("originBadge", { origin: h.originClient ?? h.origin })}
                  </Badge>
                )}
              </p>
              {showValues(h) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13.5px]">
                  <span className="text-text-2 line-through decoration-text-3/50">{renderValue(h.field, h.fromValue)}</span>
                  <span className="text-text-3">→</span>
                  <span className="text-text">{renderValue(h.field, h.toValue)}</span>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
