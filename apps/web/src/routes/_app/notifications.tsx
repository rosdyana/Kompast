import { createFileRoute, useRouter } from "@tanstack/react-router";
import { listNotificationPrefsFn, setNotificationPrefFn } from "@/lib/server-fns/notifications";

export const Route = createFileRoute("/_app/notifications")({
  loader: () => listNotificationPrefsFn(),
  component: NotificationsPage,
});

const DIGEST_LABEL: Record<string, string> = { instant: "Langsung", hourly: "Per jam", daily: "Harian", off: "Nonaktif" };

function NotificationsPage() {
  const prefs = Route.useLoaderData();
  const router = useRouter();

  async function updatePref(eventType: string, patch: { inApp?: boolean; email?: boolean; digest?: "instant" | "hourly" | "daily" | "off" }) {
    await setNotificationPrefFn({ data: { eventType, ...patch } });
    await router.invalidate();
  }

  return (
    <div className="mx-auto max-w-[640px] px-8 pb-16 pt-9">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Pengaturan Notifikasi</h1>
      <p className="mb-8 text-sm text-text-2">Pilih bagaimana Anda ingin diberi tahu untuk setiap jenis aktivitas.</p>

      <div className="flex flex-col gap-3">
        {prefs.map((pref) => (
          <div key={pref.eventType} className="rounded-xl border border-border bg-surface p-4">
            <p className="mb-3 text-[13px] font-semibold">{pref.label}</p>
            <div className="flex flex-wrap items-center gap-4 text-[12.5px]">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={pref.inApp} onChange={(e) => updatePref(pref.eventType, { inApp: e.target.checked })} />
                Dalam aplikasi
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={pref.email} onChange={(e) => updatePref(pref.eventType, { email: e.target.checked })} />
                Email
              </label>
              <label className="flex items-center gap-1.5 text-text-2">
                Digest:
                <select
                  value={pref.digest}
                  onChange={(e) => updatePref(pref.eventType, { digest: e.target.value as "instant" | "hourly" | "daily" | "off" })}
                  className="rounded-md border border-border bg-surface px-1.5 py-1 text-[12px]"
                >
                  {Object.entries(DIGEST_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {pref.digest !== "instant" && pref.digest !== "off" && (
              <p className="mt-2 text-[11px] text-text-3">
                Catatan: batching per jam/hari belum berjalan — email untuk preferensi ini belum dikirim sampai fitur itu dibangun.
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
