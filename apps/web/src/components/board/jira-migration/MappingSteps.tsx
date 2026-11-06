import { useMemo, useState } from "react";
import { Badge } from "@kompast/ui/Badge";
import type { SelectOption } from "@kompast/ui/SelectMenu";
import { Switch } from "@kompast/ui/Switch";
import { useTranslation } from "@kompast/i18n";
import type { JiraDiscovery, JiraMigrationMapping, JiraStatusColumnPlacement } from "@kompast/import";
import { CategoryChip, OptionPicker, StepHeading, categoryOfJiraKey, type JiraTargets, type StatusCategory } from "./shared";

type Mapping = JiraMigrationMapping;
type StatusEntry = Mapping["statuses"][number];
type PersonEntry = Mapping["people"][number];

const CATEGORIES: StatusCategory[] = ["todo", "in_progress", "done"];
const RECENT_SPRINTS = 10;

// ── Statuses and issue types ────────────────────────────────────────────────

/** Where a created status goes, as one select value: "start", "after:<column>" or "join:<column>". */
function placementValue(column: JiraStatusColumnPlacement | undefined, lastColumnId: string | null): string {
  if (!column) return lastColumnId ? `after:${lastColumnId}` : "start";
  if (column.mode === "join") return `join:${column.columnId}`;
  return column.afterColumnId ? `after:${column.afterColumnId}` : "start";
}

function placementFromValue(value: string): JiraStatusColumnPlacement {
  if (value === "start") return { mode: "new", afterColumnId: null };
  if (value.startsWith("join:")) return { mode: "join", columnId: value.slice("join:".length) };
  return { mode: "new", afterColumnId: value.slice("after:".length) };
}

export function StatusesStep({
  discovery,
  targets,
  mapping,
  onChange,
}: {
  discovery: JiraDiscovery;
  targets: JiraTargets;
  mapping: Mapping;
  onChange: (next: Mapping) => void;
}) {
  const { t } = useTranslation("board");
  const lastColumnId = targets.columns.at(-1)?.id ?? null;
  const jiraCategoryOf = useMemo(() => new Map(discovery.statuses.map((s) => [s.name, categoryOfJiraKey(s.categoryKey)])), [discovery.statuses]);
  const priorityByName = useMemo(
    () => new Map((mapping.priorities ?? []).map((p) => [p.jiraName.toLowerCase(), p.kompastKey])),
    [mapping.priorities],
  );
  const priorityOptions: SelectOption[] = targets.priorities.map((l) => ({ value: l.key, label: l.name }));

  function setPriority(jiraName: string, kompastKey: string) {
    const others = (mapping.priorities ?? []).filter((p) => p.jiraName.toLowerCase() !== jiraName.toLowerCase());
    onChange({ ...mapping, priorities: [...others, { jiraName, kompastKey }] });
  }

  function setStatus(index: number, value: string) {
    const entry = mapping.statuses[index]!;
    let next: StatusEntry;
    if (value.startsWith("map:")) {
      const id = value.slice("map:".length);
      const target = targets.statuses.find((s) => s.id === id);
      next = { jiraName: entry.jiraName, category: target?.category ?? entry.category, action: "map", kompastStatusId: id };
    } else {
      next = {
        jiraName: entry.jiraName,
        category: entry.category,
        action: "create",
        column: entry.action === "create" && entry.column ? entry.column : { mode: "new", afterColumnId: lastColumnId },
      };
    }
    onChange({ ...mapping, statuses: mapping.statuses.map((s, i) => (i === index ? next : s)) });
  }

  function patchStatus(index: number, patch: Partial<StatusEntry>) {
    onChange({ ...mapping, statuses: mapping.statuses.map((s, i) => (i === index ? ({ ...s, ...patch } as StatusEntry) : s)) });
  }

  function setType(index: number, value: string) {
    const entry = mapping.types[index]!;
    const next: Mapping["types"][number] = value.startsWith("map:")
      ? { jiraName: entry.jiraName, action: "map", kompastTypeId: value.slice("map:".length) }
      : { jiraName: entry.jiraName, action: "create" };
    onChange({ ...mapping, types: mapping.types.map((tp, i) => (i === index ? next : tp)) });
  }

  const columnOptions: SelectOption[] = [
    { value: "start", label: t("jiraMigration.statuses.columnStart") },
    ...targets.columns.map((c) => ({ value: `after:${c.id}`, label: t("jiraMigration.statuses.columnAfter", { column: c.name }) })),
    ...targets.columns.map((c) => ({ value: `join:${c.id}`, label: t("jiraMigration.statuses.columnJoin", { column: c.name }) })),
  ];
  const categoryOptions: SelectOption[] = CATEGORIES.map((c) => ({ value: c, label: t(`jiraMigration.category.${c}`) }));

  return (
    <div>
      <StepHeading title={t("jiraMigration.statuses.heading")} description={t("jiraMigration.statuses.subtitle")} />

      <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
        <table className="w-full min-w-[640px] text-left text-[13.5px]">
          <thead className="bg-surface-2 type-label-overline text-text-2">
            <tr>
              <th className="px-3 py-2.5 font-semibold">{t("jiraMigration.statuses.colJira")}</th>
              <th className="px-3 py-2.5 font-semibold">{t("jiraMigration.statuses.colKompast")}</th>
            </tr>
          </thead>
          <tbody>
            {mapping.statuses.map((entry, index) => {
              const jiraCategory = jiraCategoryOf.get(entry.jiraName) ?? entry.category;
              const choice = entry.action === "map" ? `map:${entry.kompastStatusId}` : "create";
              const choices: SelectOption[] = [
                ...targets.statuses.map((s) => ({ value: `map:${s.id}`, label: s.name, hint: t(`jiraMigration.category.${s.category}`) })),
                { value: "create", label: t("jiraMigration.statuses.createOption", { name: entry.jiraName }) },
              ];
              return (
                <tr key={entry.jiraName} className="border-t border-border align-top">
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-text">{entry.jiraName}</span>
                      <CategoryChip category={jiraCategory} />
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="grid max-w-[620px] grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                      <OptionPicker
                        ariaLabel={entry.jiraName}
                        value={choice}
                        options={choices}
                        onChange={(v) => setStatus(index, v)}
                        width={320}
                      />
                      {entry.action === "create" && (
                        <>
                          <OptionPicker
                            ariaLabel={t("jiraMigration.statuses.categoryLabel")}
                            value={entry.category}
                            options={categoryOptions}
                            onChange={(v) => patchStatus(index, { category: v as StatusCategory })}
                            width={200}
                          />
                          <div className="sm:col-span-2">
                            <OptionPicker
                              ariaLabel={t("jiraMigration.statuses.columnLabel")}
                              value={placementValue(entry.column, lastColumnId)}
                              options={columnOptions}
                              onChange={(v) => patchStatus(index, { column: placementFromValue(v) })}
                              width={360}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h4 className="mb-2 mt-6 type-headline text-[15px]">{t("jiraMigration.statuses.typesHeading")}</h4>
      <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
        <table className="w-full min-w-[480px] text-left text-[13.5px]">
          <thead className="bg-surface-2 type-label-overline text-text-2">
            <tr>
              <th className="px-3 py-2.5 font-semibold">{t("jiraMigration.statuses.colJira")}</th>
              <th className="px-3 py-2.5 font-semibold">{t("jiraMigration.statuses.colKompast")}</th>
            </tr>
          </thead>
          <tbody>
            {mapping.types.map((entry, index) => {
              const choice = entry.action === "map" ? `map:${entry.kompastTypeId}` : "create";
              const choices: SelectOption[] = [
                ...targets.types.map((tp) => ({ value: `map:${tp.id}`, label: tp.name })),
                { value: "create", label: t("jiraMigration.statuses.createOption", { name: entry.jiraName }) },
              ];
              return (
                <tr key={entry.jiraName} className="border-t border-border">
                  <td className="px-3 py-2.5 font-medium">{entry.jiraName}</td>
                  <td className="px-3 py-2.5">
                    <div className="max-w-[320px]">
                      <OptionPicker ariaLabel={entry.jiraName} value={choice} options={choices} onChange={(v) => setType(index, v)} width={320} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {discovery.priorities.length > 0 && (
        <>
          <h4 className="mb-2 mt-6 type-headline text-[15px]">{t("jiraMigration.statuses.prioritiesHeading")}</h4>
          <p className="mb-2 type-small text-text-2">{t("jiraMigration.statuses.prioritiesSubtitle")}</p>
          <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
            <table className="w-full min-w-[480px] text-left text-[13.5px]">
              <thead className="bg-surface-2 type-label-overline text-text-2">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">{t("jiraMigration.statuses.colJira")}</th>
                  <th className="px-3 py-2.5 font-semibold">{t("jiraMigration.statuses.colKompast")}</th>
                </tr>
              </thead>
              <tbody>
                {discovery.priorities.map((p) => (
                  <tr key={p.name} className="border-t border-border">
                    <td className="px-3 py-2.5 font-medium">{p.name}</td>
                    <td className="px-3 py-2.5">
                      <div className="max-w-[320px]">
                        <OptionPicker
                          ariaLabel={p.name}
                          value={priorityByName.get(p.name.toLowerCase()) ?? null}
                          options={priorityOptions}
                          placeholder={t("jiraMigration.statuses.priorityPlaceholder")}
                          onChange={(v) => setPriority(p.name, v)}
                          width={320}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── People ──────────────────────────────────────────────────────────────────

export function PeopleStep({
  discovery,
  targets,
  mapping,
  onChange,
}: {
  discovery: JiraDiscovery;
  targets: JiraTargets;
  mapping: Mapping;
  onChange: (next: Mapping) => void;
}) {
  const { t } = useTranslation("board");
  const entryFor = useMemo(() => new Map(mapping.people.map((p) => [p.accountId, p])), [mapping.people]);
  const maxSprint = discovery.people.reduce<number | null>((max, p) => (p.lastSprintNumber === null ? max : max === null ? p.lastSprintNumber : Math.max(max, p.lastSprintNumber)), null);
  const cutoff = maxSprint === null ? null : maxSprint - (RECENT_SPRINTS - 1);
  const isRecent = (lastSprint: number | null) => cutoff === null || (lastSprint !== null && lastSprint >= cutoff);

  const sorted = useMemo(
    () =>
      [...discovery.people].sort((a, b) => {
        const sa = a.lastSprintNumber ?? -Infinity;
        const sb = b.lastSprintNumber ?? -Infinity;
        return sb - sa || b.touches - a.touches;
      }),
    [discovery.people],
  );
  const hiddenCount = sorted.filter((p) => !isRecent(p.lastSprintNumber)).length;
  // On by default only when it actually hides someone.
  const [recentOnly, setRecentOnly] = useState(hiddenCount > 0);
  const visible = sorted.filter((p) => !recentOnly || isRecent(p.lastSprintNumber));

  const memberOptions: SelectOption[] = [
    ...targets.members.map((m) => ({ value: `map:${m.userId}`, label: m.name, hint: m.email ?? undefined })),
    { value: "former", label: t("jiraMigration.people.formerMember") },
  ];

  function setPerson(accountId: string, displayName: string, value: string) {
    const current = entryFor.get(accountId);
    const next: PersonEntry =
      value === "former"
        ? { accountId, displayName, action: "former", confidence: "none" }
        : { accountId, displayName, action: "map", kompastUserId: value.slice("map:".length), confidence: "none" };
    // A changed choice is no longer the suggestion, so the "matched by" chip goes.
    const unchanged = current && current.action === "map" && next.action === "map" && current.kompastUserId === next.kompastUserId;
    if (unchanged) return;
    onChange({ ...mapping, people: mapping.people.map((p) => (p.accountId === accountId ? next : p)) });
  }

  return (
    <div>
      <StepHeading title={t("jiraMigration.people.heading")} description={t("jiraMigration.people.subtitle")} />

      {hiddenCount > 0 && (
        <div className="mb-3">
          <Switch
            checked={recentOnly}
            onChange={setRecentOnly}
            label={t("jiraMigration.people.recentOnly", { sprints: RECENT_SPRINTS })}
          />
        </div>
      )}

      <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
        <table className="w-full min-w-[720px] text-left text-[13.5px]">
          <thead className="bg-surface-2 type-label-overline text-text-2">
            <tr>
              <th className="px-3 py-2.5 font-semibold">{t("jiraMigration.people.colPerson")}</th>
              <th className="px-3 py-2.5 text-right font-semibold">{t("jiraMigration.people.colIssues")}</th>
              <th className="px-3 py-2.5 font-semibold">{t("jiraMigration.people.colLastSprint")}</th>
              <th className="px-3 py-2.5 font-semibold">{t("jiraMigration.people.colAccount")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((person) => {
              const entry = entryFor.get(person.accountId);
              const choice = entry?.action === "map" ? `map:${entry.kompastUserId}` : entry ? "former" : null;
              return (
                <tr key={person.accountId} className="border-t border-border align-top">
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-text">{person.displayName}</span>
                      {!person.active && <Badge tone="danger">{t("jiraMigration.people.deactivated")}</Badge>}
                      {person.accountType === "app" && <Badge tone="neutral">{t("jiraMigration.people.bot")}</Badge>}
                    </div>
                    {person.emailAddress && <div className="type-small text-text-3">{person.emailAddress}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-text-2">{person.touches}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-text-2">
                    {person.lastSprintNumber !== null ? t("jiraMigration.people.sprintName", { number: person.lastSprintNumber }) : t("jiraMigration.people.noSprint")}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex max-w-[400px] flex-col items-start gap-1.5">
                      <div className="w-full">
                        <OptionPicker
                          ariaLabel={person.displayName}
                          value={choice}
                          options={memberOptions}
                          onChange={(v) => setPerson(person.accountId, person.displayName, v)}
                          width={320}
                        />
                      </div>
                      {entry && entry.action === "map" && entry.confidence !== "none" && (
                        <Badge tone="accent">{entry.confidence === "email" ? t("jiraMigration.people.matchedByEmail") : t("jiraMigration.people.matchedByName")}</Badge>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {recentOnly && hiddenCount > 0 && <p className="mt-2 type-small text-text-3">{t("jiraMigration.people.hiddenCount", { count: hiddenCount })}</p>}
    </div>
  );
}
