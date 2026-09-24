import { useState } from "react";
import { CalendarRange } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { FormField, NativeSelect, TextField } from "@kompast/ui/Input";
import { useTranslation } from "@kompast/i18n";
import { createSprintFn } from "@/lib/server-fns/sprints";

const CYCLE_OPTIONS: Array<{ value: "1w" | "2w" | "3w" | "4w" | "custom"; labelKey: string }> = [
  { value: "1w", labelKey: "sprint.cycle1w" },
  { value: "2w", labelKey: "sprint.cycle2w" },
  { value: "3w", labelKey: "sprint.cycle3w" },
  { value: "4w", labelKey: "sprint.cycle4w" },
  { value: "custom", labelKey: "sprint.wizardCycleCustom" },
];

export function SprintSetupWizard({ boardId, onCreated }: { boardId: string; onCreated: () => void }) {
  const { t } = useTranslation("board");
  const [cycle, setCycle] = useState<"1w" | "2w" | "3w" | "4w" | "custom">("2w");
  const [startingNumber, setStartingNumber] = useState("1");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const number = Number.parseInt(startingNumber, 10);
    if (!Number.isInteger(number) || number < 1) {
      setError(t("sprint.wizardInvalidNumber"));
      return;
    }
    if (cycle === "custom" && (!customStart || !customEnd)) {
      setError(t("sprint.wizardCustomDatesRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createSprintFn({
        data: {
          boardId,
          number,
          cycle,
          startAt: cycle === "custom" ? new Date(customStart) : undefined,
          endAt: cycle === "custom" ? new Date(customEnd) : undefined,
        },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex justify-center px-4 py-10">
      <form
        className="w-full max-w-[460px] rounded-[12px] border border-border bg-surface p-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="mb-5 flex items-start gap-3">
          <span className="grid h-10 w-10 flex-none place-items-center rounded-[10px] bg-accent-soft text-accent-text">
            <CalendarRange size={19} />
          </span>
          <div>
            <h2 className="type-headline text-[17px]">{t("sprint.wizardHeading")}</h2>
            <p className="mt-0.5 type-small text-text-2">{t("sprint.wizardSubtitle")}</p>
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <FormField label={t("sprint.wizardCycleLabel")} htmlFor="wizard-cycle">
            <NativeSelect id="wizard-cycle" value={cycle} onChange={(e) => setCycle(e.target.value as typeof cycle)}>
              {CYCLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(opt.labelKey)}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          {cycle === "custom" && (
            <div className="grid grid-cols-2 gap-3">
              <FormField label={t("sprint.wizardCustomStartLabel")} htmlFor="wizard-start">
                <TextField id="wizard-start" type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
              </FormField>
              <FormField label={t("sprint.wizardCustomEndLabel")} htmlFor="wizard-end">
                <TextField id="wizard-end" type="date" value={customEnd} min={customStart || undefined} onChange={(e) => setCustomEnd(e.target.value)} />
              </FormField>
            </div>
          )}
          <FormField label={t("sprint.wizardStartingNumberLabel")} htmlFor="wizard-number" hint={t("sprint.wizardStartingNumberHint")}>
            <TextField id="wizard-number" type="number" min={1} value={startingNumber} onChange={(e) => setStartingNumber(e.target.value)} />
          </FormField>
          {error && <p className="rounded-[6px] bg-danger-soft px-3 py-2 type-small text-danger">{error}</p>}
          <div className="flex items-center justify-between gap-3 pt-1">
            <span className="type-small text-text-3">{t("sprint.wizardCardHint")}</span>
            <Button type="submit" variant="primary" disabled={busy}>
              {t("sprint.wizardSubmitButton")}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
