import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { Card } from "@kompast/ui/Card";
import { FormField, TextField } from "@kompast/ui/Input";
import { useTranslation } from "@kompast/i18n";
import { getSetupStatusFn, completeSetupFn } from "@/lib/server-fns/setup";
import { AuthLayout } from "@/components/auth/AuthLayout";

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
  const [redirectUri, setRedirectUri] = useState("<APP_URL>/api/auth/callback/microsoft-entra-id");
  const [copied, setCopied] = useState(false);

  useEffect(() => setRedirectUri(`${window.location.origin}/api/auth/callback/microsoft-entra-id`), []);

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

  async function copy() {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — the URI stays visible to select manually
    }
  }

  const steps = [t("setupStep1"), t("setupStep2"), t("setupStep3")];

  return (
    <AuthLayout>
      <h2 className="type-title">{t("setupTitle")}</h2>
      <p className="mt-2 type-body text-text-2">{t("setupSubtitle")}</p>

      <ol className="mt-6 flex flex-col gap-2">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-3 text-[14px] text-text-2">
            <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent-text">{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      <div className="mt-5 rounded-[8px] border border-border bg-surface-2 p-3">
        <p className="mb-2 text-[12.5px] text-text-2">{t("redirectUriNote")}</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-text">{redirectUri}</code>
          <Button size="sm" variant="outline" onClick={copy}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? t("copied") : t("copy")}
          </Button>
        </div>
      </div>

      <Card className="mt-5">
        <form
          className="flex flex-col gap-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <FormField label={t("tenantIdLabel")} htmlFor="setup-tenant" required>
            <TextField id="setup-tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" className="font-mono text-[13px]" />
          </FormField>
          <FormField label={t("clientIdLabel")} htmlFor="setup-client" required>
            <TextField id="setup-client" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={t("clientIdPlaceholder")} className="font-mono text-[13px]" />
          </FormField>
          <FormField label={t("clientSecretLabel")} htmlFor="setup-secret" required error={error ?? undefined}>
            <TextField id="setup-secret" type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={t("clientSecretPlaceholder")} />
          </FormField>
          <Button type="submit" variant="primary" size="lg" disabled={submitting || !tenantId.trim() || !clientId.trim() || !clientSecret} className="w-full">
            {submitting ? t("savingEllipsis") : t("saveAndContinue")}
          </Button>
        </form>
      </Card>
    </AuthLayout>
  );
}
