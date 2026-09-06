import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { useTranslation } from "@kompast/i18n";
import { getSetupStatusFn, completeSetupFn } from "@/lib/server-fns/setup";

export const Route = createFileRoute("/setup")({
  loader: async () => {
    const status = await getSetupStatusFn();
    if (status.isConfigured) throw redirect({ to: "/login" });
    return status;
  },
  component: SetupPage,
});

function SetupPage() {
  const { t } = useTranslation("auth");
  const router = useRouter();
  const [tenantId, setTenantId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      await completeSetupFn({ data: { tenantId: tenantId.trim(), clientId: clientId.trim(), clientSecret } });
      await router.navigate({ to: "/login" });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6">
      <div className="w-full max-w-[440px]">
        <div className="mb-7 flex items-center gap-2.5">
          <div className="grid h-[30px] w-[30px] place-items-center rounded-[9px] bg-accent">
            <div className="h-2 w-2 rotate-45 rounded-sm bg-white" />
          </div>
          <span className="type-headline">Kompast</span>
        </div>

        <h1 className="mb-2 type-title">{t("setupTitle")}</h1>
        <p className="mb-7 type-body leading-relaxed text-text-2">{t("setupSubtitle")}</p>

        <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5">
          <Field label={t("tenantIdLabel")} value={tenantId} onChange={setTenantId} placeholder="00000000-0000-0000-0000-000000000000" />
          <Field label={t("clientIdLabel")} value={clientId} onChange={setClientId} placeholder={t("clientIdPlaceholder")} />
          <Field
            label={t("clientSecretLabel")}
            value={clientSecret}
            onChange={setClientSecret}
            placeholder={t("clientSecretPlaceholder")}
            type="password"
          />

          {error && <p className="type-body text-danger">{error}</p>}

          <Button
            variant="primary"
            onClick={submit}
            disabled={submitting || !tenantId || !clientId || !clientSecret}
            className="w-full py-2.5"
          >
            {submitting ? t("savingEllipsis") : t("saveAndContinue")}
          </Button>
        </div>

        <p className="mt-5 type-body leading-relaxed text-text-3">
          {t("redirectUriNote")}{" "}
          <code className="rounded bg-surface-3 px-1 py-0.5">{"<APP_URL>"}/api/auth/callback/microsoft-entra-id</code>
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-text-2">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none focus:border-text-3"
      />
    </label>
  );
}
