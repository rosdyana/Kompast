import { useRouter } from "@tanstack/react-router";
import { Card } from "@kompast/ui/Card";
import { useTranslation } from "@kompast/i18n";
import { listNotificationPrefsFn, setNotificationPrefFn } from "@/lib/server-fns/notifications";

const DIGEST_VALUES = ["instant", "hourly", "daily", "off"] as const;

export function NotificationsTab({ data }: { data: Awaited<ReturnType<typeof listNotificationPrefsFn>> }) {
  const { t } = useTranslation("notifications");
  const router = useRouter();

  async function updatePref(eventType: string, patch: { inApp?: boolean; email?: boolean; digest?: "instant" | "hourly" | "daily" | "off" }) {
    await setNotificationPrefFn({ data: { eventType, ...patch } });
    await router.invalidate();
  }

  return (
    <div>
      <p className="mb-6 type-body text-text-2">{t("pageSubtitle")}</p>
      <div className="flex flex-col gap-3">
        {data.map((pref) => (
          <Card key={pref.eventType} className="p-4">
            <p className="mb-3 type-headline">{pref.label}</p>
            <div className="flex flex-wrap items-center gap-4 text-[12.5px]">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={pref.inApp} onChange={(e) => updatePref(pref.eventType, { inApp: e.target.checked })} />
                {t("inApp")}
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={pref.email} onChange={(e) => updatePref(pref.eventType, { email: e.target.checked })} />
                {t("email")}
              </label>
              <label className="flex items-center gap-1.5 text-text-2">
                {t("digest")}
                <select
                  value={pref.digest}
                  onChange={(e) => updatePref(pref.eventType, { digest: e.target.value as "instant" | "hourly" | "daily" | "off" })}
                  className="kp-select kp-field"
                >
                  {DIGEST_VALUES.map((value) => (
                    <option key={value} value={value}>
                      {t(`digest_${value}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {pref.digest !== "instant" && pref.digest !== "off" && (
              <p className="mt-2 type-body text-text-3">{t("digestNote")}</p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
