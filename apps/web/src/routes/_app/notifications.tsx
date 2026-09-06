import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PageContainer } from "@kompast/ui/PageContainer";
import { PageHeader } from "@kompast/ui/PageHeader";
import { Card } from "@kompast/ui/Card";
import { useTranslation } from "@kompast/i18n";
import { listNotificationPrefsFn, setNotificationPrefFn } from "@/lib/server-fns/notifications";

export const Route = createFileRoute("/_app/notifications")({
  loader: () => listNotificationPrefsFn(),
  component: NotificationsPage,
});

const DIGEST_VALUES = ["instant", "hourly", "daily", "off"] as const;

function NotificationsPage() {
  const { t } = useTranslation("notifications");
  const prefs = Route.useLoaderData();
  const router = useRouter();

  async function updatePref(eventType: string, patch: { inApp?: boolean; email?: boolean; digest?: "instant" | "hourly" | "daily" | "off" }) {
    await setNotificationPrefFn({ data: { eventType, ...patch } });
    await router.invalidate();
  }

  return (
    <PageContainer width="standard">
      <PageHeader title={t("pageTitle")} subtitle={t("pageSubtitle")} />

      <div className="flex flex-col gap-3">
        {prefs.map((pref) => (
          <Card key={pref.eventType} className="p-4">
            <p className="mb-3 text-[13px] font-semibold">{pref.label}</p>
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
                  className="kp-select rounded-[7px] border border-border bg-surface px-2 py-1 text-[12px]"
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
              <p className="mt-2 text-[11px] text-text-3">{t("digestNote")}</p>
            )}
          </Card>
        ))}
      </div>
    </PageContainer>
  );
}
