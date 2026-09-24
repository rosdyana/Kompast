import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Card } from "@kompast/ui/Card";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation } from "@kompast/i18n";
import { listNotificationPrefsFn, setNotificationPrefFn } from "@/lib/server-fns/notifications";
import { SettingsSection, Switch } from "./SettingsSection";

const DIGEST_VALUES = ["instant", "hourly", "daily", "off"] as const;
type Digest = (typeof DIGEST_VALUES)[number];
type Pref = Awaited<ReturnType<typeof listNotificationPrefsFn>>[number];

export function NotificationsTab({ data }: { data: Pref[] }) {
  const { t } = useTranslation("notifications");
  const router = useRouter();
  const toast = useToast();
  // Optimistic local copy so toggles respond instantly; the loader refresh reconciles.
  const [prefs, setPrefs] = useState(data);

  async function updatePref(eventType: string, patch: { inApp?: boolean; email?: boolean; digest?: Digest }) {
    const before = prefs;
    setPrefs((list) => list.map((p) => (p.eventType === eventType ? { ...p, ...patch } : p)));
    try {
      await setNotificationPrefFn({ data: { eventType, ...patch } });
      await router.invalidate();
    } catch {
      setPrefs(before);
      toast.show({ tone: "error", title: t("saveFailed") });
    }
  }

  const eventLabel = (p: Pref) => t(`event.${p.eventType}` as "event.issue.assigned", { defaultValue: p.label });

  return (
    <SettingsSection title={t("bellTitle")} description={t("pageSubtitle")}>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-[14px]">
          <thead>
            <tr className="border-b border-border text-[12.5px] text-text-3">
              <th className="px-4 py-2.5 font-medium">{t("eventHeading")}</th>
              <th className="w-[90px] px-3 py-2.5 text-center font-medium">{t("inApp")}</th>
              <th className="w-[90px] px-3 py-2.5 text-center font-medium">{t("email")}</th>
              <th className="w-[140px] px-4 py-2.5 font-medium">{t("digest").replace(/:$/, "")}</th>
            </tr>
          </thead>
          <tbody>
            {prefs.map((pref) => (
              <tr key={pref.eventType} className="border-b border-border last:border-b-0">
                <td className="px-4 py-3">
                  <p>{eventLabel(pref)}</p>
                  {pref.email && pref.digest !== "instant" && pref.digest !== "off" && <p className="mt-0.5 text-[12.5px] text-amber">{t("digestNote")}</p>}
                </td>
                <td className="px-3 py-3 text-center">
                  <Switch srOnlyLabel checked={pref.inApp} onChange={(v) => updatePref(pref.eventType, { inApp: v })} label={`${eventLabel(pref)} — ${t("inApp")}`} />
                </td>
                <td className="px-3 py-3 text-center">
                  <Switch srOnlyLabel checked={pref.email} onChange={(v) => updatePref(pref.eventType, { email: v })} label={`${eventLabel(pref)} — ${t("email")}`} />
                </td>
                <td className="px-4 py-3">
                  <select
                    value={pref.digest}
                    disabled={!pref.email}
                    aria-label={`${eventLabel(pref)} — ${t("digest")}`}
                    onChange={(e) => updatePref(pref.eventType, { digest: e.target.value as Digest })}
                    className="kp-field kp-select w-full disabled:opacity-50"
                  >
                    {DIGEST_VALUES.map((value) => (
                      <option key={value} value={value}>
                        {t(`digest_${value}`)}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </SettingsSection>
  );
}
