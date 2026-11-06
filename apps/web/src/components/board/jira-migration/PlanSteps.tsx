import { useState } from "react";
import { Badge } from "@kompast/ui/Badge";
import { Button } from "@kompast/ui/Button";
import { Dialog } from "@kompast/ui/Dialog";
import { useTranslation } from "@kompast/i18n";
import type { JiraDiscovery, JiraMigrationMapping } from "@kompast/import";
import { StatCard, StepHeading, categoryOfJiraKey, formatBytes, type JiraPreview, type SprintState } from "./shared";

type Mapping = JiraMigrationMapping;

// ── Sprints ─────────────────────────────────────────────────────────────────

const ACTION_TONE = { create: "accent", "existing-active": "indigo", "already-imported": "neutral" } as const;

export function SprintsStep({ preview }: { preview: JiraPreview | null }) {
  const { t } = useTranslation("board");
  if (!preview) return <p className="type-small text-text-3">{t("jiraMigration.loading")}</p>;

  const counts = (state: SprintState) => preview.sprints.filter((s) => s.state === state).length;

  return (
    <div>
      <StepHeading title={t("jiraMigration.sprints.heading")} description={t("jiraMigration.sprints.subtitle")} />
      {preview.sprints.length === 0 ? (
        <p className="type-small text-text-2">{t("jiraMigration.sprints.empty")}</p>
      ) : (
        <>
          <p className="mb-3 type-small text-text-2">
            {t("jiraMigration.sprints.summary", { closed: counts("closed"), active: counts("active"), future: counts("future") })}
          </p>
          <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
            <table className="w-full min-w-[640px] text-left text-[13.5px]">
              <thead className="bg-surface-2 type-label-overline text-text-2">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">{t("jiraMigration.sprints.colJira")}</th>
                  <th className="px-3 py-2.5 font-semibold">{t("jiraMigration.sprints.colKompast")}</th>
                  <th className="px-3 py-2.5 font-semibold">{t("jiraMigration.sprints.colAction")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.sprints.map((s) => {
                  // JIRA had this one active but the board already had an active sprint, so Kompast takes it as future.
                  const demoted = s.jiraState === "active" && s.state === "future";
                  return (
                    <tr key={s.jiraSprintId} className="border-t border-border align-top">
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-text">{s.jiraName}</div>
                        <div className="type-small text-text-3">{t(`jiraMigration.sprintState.${s.jiraState}`)}</div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="text-text">{t("jiraMigration.sprints.sprintName", { number: s.number })}</div>
                        <div className="type-small text-text-3">{t(`jiraMigration.sprintState.${s.state}`)}</div>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={ACTION_TONE[s.action]}>{t(`jiraMigration.sprints.action.${s.action}`)}</Badge>
                        {demoted && <p className="mt-1.5 max-w-[360px] type-small text-amber">{t("jiraMigration.sprints.demotedNote")}</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── Attachments ─────────────────────────────────────────────────────────────

const MB = 1024 * 1024;
/** The slider's stops, in MB. The last stop is "No limit" (null). */
const LIMIT_STOPS_MB = [1, 2, 5, 10, 20, 50, 100] as const;
const NO_LIMIT_INDEX = LIMIT_STOPS_MB.length;

function stopIndexOf(limit: number | null): number {
  if (limit === null) return NO_LIMIT_INDEX;
  let best = 0;
  for (let i = 0; i < LIMIT_STOPS_MB.length; i++) {
    if (Math.abs(LIMIT_STOPS_MB[i]! * MB - limit) < Math.abs(LIMIT_STOPS_MB[best]! * MB - limit)) best = i;
  }
  return best;
}

export function AttachmentsStep({
  discovery,
  mapping,
  onChange,
}: {
  discovery: JiraDiscovery;
  mapping: Mapping;
  onChange: (next: Mapping) => void;
}) {
  const { t } = useTranslation("board");
  const index = stopIndexOf(mapping.attachmentMaxBytes);
  const limit = index === NO_LIMIT_INDEX ? null : LIMIT_STOPS_MB[index]! * MB;
  const sizes = discovery.attachmentSizes;
  const copied = sizes.filter((s) => limit === null || s <= limit);
  const stayInJira = sizes.filter((s) => limit !== null && s > limit);
  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const stopLabel = index === NO_LIMIT_INDEX ? t("jiraMigration.attachments.noLimit") : `${LIMIT_STOPS_MB[index]} MB`;

  function setIndex(next: number) {
    onChange({ ...mapping, attachmentMaxBytes: next === NO_LIMIT_INDEX ? null : LIMIT_STOPS_MB[next]! * MB });
  }

  return (
    <div>
      <StepHeading title={t("jiraMigration.attachments.heading")} description={t("jiraMigration.attachments.subtitle")} />

      <div className="max-w-[620px] rounded-[10px] border border-border bg-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="jm-attachment-limit" className="text-[13px] font-medium text-text-2">
            {t("jiraMigration.attachments.limitLabel")}
          </label>
          <span className="tabular-nums text-[14px] font-medium text-text">{stopLabel}</span>
        </div>
        <input
          id="jm-attachment-limit"
          type="range"
          min={0}
          max={NO_LIMIT_INDEX}
          step={1}
          value={index}
          onChange={(e) => setIndex(Number(e.target.value))}
          className="mt-3 w-full accent-accent"
          aria-valuetext={stopLabel}
        />
        <div className="mt-1 flex justify-between type-small text-text-3">
          <span>{LIMIT_STOPS_MB[0]} MB</span>
          <span>{t("jiraMigration.attachments.noLimit")}</span>
        </div>

        <div className="mt-4 flex flex-col gap-1.5 text-[14px] text-text">
          <p>{t("jiraMigration.attachments.copiedLine", { count: copied.length, size: formatBytes(total(copied)) })}</p>
          <p className="text-text-2">{t("jiraMigration.attachments.stayLine", { count: stayInJira.length, size: formatBytes(total(stayInJira)) })}</p>
        </div>
      </div>
      <p className="mt-3 max-w-[620px] type-small text-text-3">{t("jiraMigration.attachments.imagesNote")}</p>
    </div>
  );
}

// ── Review ──────────────────────────────────────────────────────────────────

export function ReviewStep({
  discovery,
  mapping,
  preview,
  issueKey,
  canStart,
  busy,
  onStart,
}: {
  discovery: JiraDiscovery;
  mapping: Mapping;
  preview: JiraPreview | null;
  issueKey: string;
  canStart: boolean;
  busy: boolean;
  onStart: () => void;
}) {
  const { t } = useTranslation("board");
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (!preview) return <p className="type-small text-text-3">{t("jiraMigration.loading")}</p>;

  const jiraCategory = new Map(discovery.statuses.map((s) => [s.name, categoryOfJiraKey(s.categoryKey)]));
  const categoryMismatches = mapping.statuses.filter((s) => {
    const jira = jiraCategory.get(s.jiraName);
    return jira !== undefined && jira !== s.category;
  });
  const sprintCount = (action: string) => preview.sprints.filter((s) => s.action === action).length;
  const fieldEntries = mapping.fields ?? [];
  const fieldsToCore = fieldEntries.filter((f) => f.action === "core").length;
  const fieldsToCreate = fieldEntries.filter((f) => f.action === "property" && f.create).length;
  const fieldsSkipped = fieldEntries.filter((f) => f.action === "skip").length;
  const range =
    preview.minKeyNumber !== null && preview.maxKeyNumber !== null
      ? t("jiraMigration.review.keyRange", { first: `${issueKey}-${preview.minKeyNumber}`, last: `${issueKey}-${preview.maxKeyNumber}` })
      : null;

  return (
    <div>
      <StepHeading title={t("jiraMigration.review.heading")} description={t("jiraMigration.review.subtitle")} />

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label={t("jiraMigration.review.issuesCard")}>
          <span className="tabular-nums">{t("jiraMigration.review.issueCount", { count: preview.issueCount })}</span>
          {range && <span className="block type-small text-text-3">{range}</span>}
        </StatCard>
        <StatCard label={t("jiraMigration.review.statusesCard")}>
          {t("jiraMigration.review.statusesLine", { count: preview.statusesToCreate.length })}
        </StatCard>
        <StatCard label={t("jiraMigration.review.typesCard")}>{t("jiraMigration.review.typesLine", { count: preview.typesToCreate.length })}</StatCard>
        <StatCard label={t("jiraMigration.review.peopleCard")}>
          {t("jiraMigration.review.peopleLine", { mapped: preview.people.mapped, former: preview.people.former })}
        </StatCard>
        <StatCard label={t("jiraMigration.review.fieldsCard")}>
          {t("jiraMigration.review.fieldsLine", { core: fieldsToCore, created: fieldsToCreate, skipped: fieldsSkipped })}
        </StatCard>
        <StatCard label={t("jiraMigration.review.sprintsCard")}>
          {t("jiraMigration.review.sprintsLine", { created: sprintCount("create"), merged: sprintCount("existing-active") })}
        </StatCard>
        <StatCard label={t("jiraMigration.review.attachmentsCard")}>
          {t("jiraMigration.review.attachmentsLine", { copied: preview.attachments.migrated, placeholders: preview.attachments.placeholders })}
        </StatCard>
      </dl>

      {categoryMismatches.length > 0 && (
        <div className="mt-4 rounded-[8px] border border-amber/40 bg-amber-soft px-4 py-3 type-small text-amber">
          <p className="font-medium">{t("jiraMigration.review.categoryWarning", { count: categoryMismatches.length })}</p>
          <p className="mt-1">{categoryMismatches.map((s) => s.jiraName).join(", ")}</p>
        </div>
      )}

      {canStart && (
        <div className="mt-6">
          <Button variant="primary" onClick={() => setConfirmOpen(true)} disabled={busy}>
            {t("jiraMigration.review.startButton")}
          </Button>
        </div>
      )}

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("jiraMigration.review.startConfirmTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setConfirmOpen(false);
                onStart();
              }}
            >
              {t("jiraMigration.review.confirmStart")}
            </Button>
          </>
        }
      >
        <p className="type-small text-text-2">{t("jiraMigration.review.startConfirmBody")}</p>
      </Dialog>
    </div>
  );
}
