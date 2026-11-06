import { useMemo } from "react";
import { Button } from "@kompast/ui/Button";
import type { SelectOption } from "@kompast/ui/SelectMenu";
import { Switch } from "@kompast/ui/Switch";
import { useTranslation } from "@kompast/i18n";
import type { JiraCoreField, JiraMigrationMapping } from "@kompast/import";
import { useIntlLocale } from "../project-shared";
import { OptionPicker, StepHeading, type JiraPreview, type JiraTargets } from "./shared";

type Mapping = JiraMigrationMapping;
type FieldEntry = NonNullable<Mapping["fields"]>[number];
type PropertyType = "text" | "textarea" | "number" | "date" | "checkbox" | "select" | "multiSelect" | "url" | "person";

const CORE_FIELDS: JiraCoreField[] = ["storyPoints", "startDate", "dueDate", "estimateSeconds"];
const PROPERTY_TYPES: PropertyType[] = ["text", "textarea", "number", "date", "checkbox", "select", "multiSelect", "url", "person"];
/** Story points with a decimal point in a sample: the column is whole numbers. */
const DECIMAL_SAMPLE = /\d\.\d/;

/** The one select value a field entry shows: "skip", "create", "core:<field>" or "prop:<key>". */
function choiceOf(entry: FieldEntry): string {
  if (entry.action === "core" && entry.coreField) return `core:${entry.coreField}`;
  if (entry.action === "property" && entry.propertyKey) return `prop:${entry.propertyKey}`;
  if (entry.action === "property") return "create";
  return "skip";
}

/**
 * The Fields step: for each JIRA field the loader doesn't handle itself, where
 * its values go. Choices are edited in the mapping draft (autosaved by the
 * wizard); usage, samples and the lists below come from the read-only preview.
 */
export function FieldsStep({
  preview,
  targets,
  mapping,
  onChange,
  onRescan,
  busy,
}: {
  preview: JiraPreview | null;
  targets: JiraTargets;
  mapping: Mapping;
  onChange: (next: Mapping) => void;
  onRescan: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation("board");
  const locale = useIntlLocale();
  const fields = mapping.fields;
  const previewById = useMemo(() => new Map((preview?.fields ?? []).map((f) => [f.jiraFieldId, f])), [preview]);
  const properties = targets.properties ?? [];
  const customProperties = properties.filter((p) => !p.isCore);
  const typeOfKey = useMemo(() => new Map(properties.map((p) => [p.key, p.type])), [properties]);
  const count = (n: number) => n.toLocaleString(locale);

  if (!fields) {
    return (
      <div>
        <StepHeading title={t("jiraMigration.fields.heading")} description={t("jiraMigration.fields.subtitle")} />
        <p className="max-w-[620px] type-small text-text-2">{t("jiraMigration.fields.rescanNeeded")}</p>
        <div className="mt-4">
          <Button variant="outline" onClick={onRescan} disabled={busy}>
            {t("jiraMigration.fields.rescan")}
          </Button>
        </div>
      </div>
    );
  }

  const list: FieldEntry[] = fields;

  function setEntry(index: number, next: FieldEntry) {
    onChange({ ...mapping, fields: list.map((f, i) => (i === index ? next : f)) });
  }

  /** A core field another entry already fills can't be chosen again. */
  function coreTakenElsewhere(core: JiraCoreField, index: number): boolean {
    return list.some((f, i) => i !== index && f.action === "core" && f.coreField === core);
  }

  function choose(index: number, value: string) {
    const entry = list[index]!;
    const base = { jiraFieldId: entry.jiraFieldId, jiraName: entry.jiraName };
    if (value === "skip") return setEntry(index, { ...base, action: "skip" });
    if (value.startsWith("core:")) return setEntry(index, { ...base, action: "core", coreField: value.slice("core:".length) as JiraCoreField });
    if (value.startsWith("prop:")) {
      const key = value.slice("prop:".length);
      const keepTransform = entry.transform && typeOfKey.get(key) === "number";
      return setEntry(index, { ...base, action: "property", propertyKey: key, ...(keepTransform ? { transform: entry.transform } : {}) });
    }
    // Create: prefilled from the inferred property (the preview's suggestion), else the JIRA name as text.
    const suggested = previewById.get(entry.jiraFieldId)?.suggested;
    const type: PropertyType = suggested?.type ?? "text";
    const transform = suggested?.transform && type === "number" ? { transform: suggested.transform } : {};
    setEntry(index, { ...base, action: "property", create: { name: suggested?.name ?? entry.jiraName, type }, ...transform });
  }

  function patchCreate(index: number, patch: { name?: string; type?: PropertyType }) {
    const entry = list[index]!;
    if (!entry.create) return;
    const create = { ...entry.create, ...patch };
    const keepTransform = entry.transform && create.type === "number";
    setEntry(index, {
      jiraFieldId: entry.jiraFieldId,
      jiraName: entry.jiraName,
      action: "property",
      create,
      ...(keepTransform ? { transform: entry.transform } : {}),
    });
  }

  function setTransform(index: number, on: boolean) {
    const { transform: _previous, ...rest } = list[index]!;
    setEntry(index, on ? { ...rest, transform: "secondsToHours" } : rest);
  }

  const choiceOptions = (index: number): SelectOption[] => [
    ...CORE_FIELDS.filter((c) => !coreTakenElsewhere(c, index)).map((c) => ({ value: `core:${c}`, label: t(`jiraMigration.fields.core.${c}`) })),
    ...customProperties.map((p) => ({ value: `prop:${p.key}`, label: p.name, hint: t(`jiraMigration.fields.type.${p.type}`) })),
    { value: "create", label: t("jiraMigration.fields.createOption") },
    { value: "skip", label: t("jiraMigration.fields.skipOption") },
  ];
  const typeOptions: SelectOption[] = PROPERTY_TYPES.map((tp) => ({ value: tp, label: t(`jiraMigration.fields.type.${tp}`) }));

  return (
    <div>
      <StepHeading title={t("jiraMigration.fields.heading")} description={t("jiraMigration.fields.subtitle")} />

      <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
        <table className="w-full min-w-[760px] text-left text-[13.5px]">
          <thead className="bg-surface-2 type-label-overline text-text-2">
            <tr>
              <th className="px-3 py-2.5 font-semibold">{t("jiraMigration.fields.colField")}</th>
              <th className="px-3 py-2.5 font-semibold">{t("jiraMigration.fields.colFilled")}</th>
              <th className="px-3 py-2.5 font-semibold">{t("jiraMigration.fields.colSamples")}</th>
              <th className="px-3 py-2.5 font-semibold">{t("jiraMigration.fields.colTarget")}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((entry, index) => {
              const shown = previewById.get(entry.jiraFieldId);
              const targetType = entry.create?.type ?? (entry.propertyKey ? typeOfKey.get(entry.propertyKey) : undefined);
              const showsDecimals = entry.action === "core" && entry.coreField === "storyPoints" && (shown?.samples ?? []).some((s) => DECIMAL_SAMPLE.test(s));
              return (
                <tr key={entry.jiraFieldId} className="border-t border-border align-top">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-text">{entry.jiraName}</div>
                    <div className="type-small text-text-3">{entry.jiraFieldId}</div>
                    {shown?.firstValueOnly && <p className="mt-1 max-w-[260px] type-small text-text-3">{t("jiraMigration.fields.firstValueNote")}</p>}
                    {shown?.reason && <p className="mt-1 max-w-[260px] type-small text-amber">{t(`jiraMigration.fields.reason.${shown.reason}`, { type: shown.schemaType ?? "" })}</p>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-text-2">
                    {shown && preview ? t("jiraMigration.fields.filled", { used: count(shown.usage), total: count(preview.issueCount) }) : "—"}
                  </td>
                  <td className="px-3 py-2.5 type-small text-text-3">
                    <div className="flex max-w-[260px] flex-col gap-0.5">
                      {(shown?.samples ?? []).map((s) => (
                        <span key={s} className="truncate">
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex w-[320px] max-w-full flex-col gap-2">
                      <OptionPicker
                        ariaLabel={entry.jiraName}
                        value={choiceOf(entry)}
                        options={choiceOptions(index)}
                        onChange={(v) => choose(index, v)}
                        width={320}
                      />
                      {entry.action === "property" && entry.create && (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_160px]">
                          <input
                            aria-label={t("jiraMigration.fields.createName")}
                            value={entry.create.name}
                            maxLength={80}
                            onChange={(e) => patchCreate(index, { name: e.target.value })}
                            className="h-8 w-full min-w-0 rounded-[6px] border border-border-2 bg-surface px-2.5 text-[13.5px] text-text"
                          />
                          <OptionPicker
                            ariaLabel={t("jiraMigration.fields.createType")}
                            value={entry.create.type}
                            options={typeOptions}
                            onChange={(v) => patchCreate(index, { type: v as PropertyType })}
                            width={200}
                          />
                        </div>
                      )}
                      {targetType === "number" && entry.action !== "skip" && (
                        <Switch
                          checked={entry.transform === "secondsToHours"}
                          onChange={(on) => setTransform(index, on)}
                          label={t("jiraMigration.fields.transformLabel")}
                        />
                      )}
                      {showsDecimals && <p className="type-small text-amber">{t("jiraMigration.fields.decimalHint")}</p>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {preview && (
        <div className="mt-6 flex flex-col gap-3">
          <details className="rounded-[10px] border border-border bg-surface px-4 py-3">
            <summary className="cursor-pointer text-[14px] font-medium text-text-2">
              {t("jiraMigration.fields.handledHeading", { count: preview.handledAutomatically.length })}
            </summary>
            <p className="mt-2 type-small text-text-3">{t("jiraMigration.fields.handledSubtitle")}</p>
            <ul className="mt-2 flex flex-col gap-1 type-small text-text-2">
              {preview.handledAutomatically.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </details>
          <details className="rounded-[10px] border border-border bg-surface px-4 py-3">
            <summary className="cursor-pointer text-[14px] font-medium text-text-2">
              {t("jiraMigration.fields.notMigratableHeading", { count: preview.notMigratable.length })}
            </summary>
            <ul className="mt-2 flex flex-col gap-1 type-small text-text-2">
              {preview.notMigratable.map((f) => (
                <li key={f.jiraName}>
                  <span className="font-medium text-text">{f.jiraName}</span> ({count(f.usage)}) · {t(`jiraMigration.fields.reason.${f.reason}`, { type: "" })}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}
