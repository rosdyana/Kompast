import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { Card } from "@kompast/ui/Card";
import { getIntegrationSettingsFn, updateAiSettingsFn, updateMailSettingsFn } from "@/lib/server-fns/settings";

export const Route = createFileRoute("/_app/settings")({
  loader: async () => {
    try {
      return await getIntegrationSettingsFn();
    } catch {
      // Not an owner/admin — the sidebar already hides this link for
      // non-admins, but someone can still type the URL directly.
      throw redirect({ to: "/" });
    }
  },
  component: SettingsPage,
});

function SettingsPage() {
  const data = Route.useLoaderData();

  return (
    <div className="mx-auto max-w-[640px] px-8 pb-16 pt-9">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Pengaturan workspace</h1>
      <p className="mb-8 text-sm text-text-2">Konfigurasi vendor AI dan email untuk seluruh deployment ini.</p>

      <AiSection initial={data.ai} />
      <div className="mt-8">
        <MailSection initial={data.mail} />
      </div>
    </div>
  );
}

function AiSection({ initial }: { initial: Awaited<ReturnType<typeof getIntegrationSettingsFn>>["ai"] }) {
  const router = useRouter();
  const [provider, setProvider] = useState(initial.provider ?? "anthropic");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial.model ?? "");
  const [azureEndpoint, setAzureEndpoint] = useState(initial.azureEndpoint ?? "");
  const [azureDeployment, setAzureDeployment] = useState(initial.azureDeployment ?? "");
  const [baseUrl, setBaseUrl] = useState(initial.openAiCompatibleBaseUrl ?? "");
  const [enabled, setEnabled] = useState(initial.featuresEnabled);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await updateAiSettingsFn({
        data: {
          provider,
          apiKey: apiKey || undefined,
          model: model || undefined,
          azureEndpoint: azureEndpoint || undefined,
          azureDeployment: azureDeployment || undefined,
          openAiCompatibleBaseUrl: baseUrl || undefined,
          featuresEnabled: enabled,
        },
      });
      setApiKey("");
      setSaved(true);
      await router.invalidate();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold">AI</h2>
      <Card className="flex flex-col gap-4 p-4">
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Aktifkan fitur AI
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-2">Provider</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as typeof provider)}
            className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none"
          >
            <option value="anthropic">Anthropic</option>
            <option value="azure-openai">Azure OpenAI</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-2">
            API key {initial.hasApiKey && <span className="text-text-3">(tersimpan — kosongkan untuk tidak mengubah)</span>}
          </span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={initial.hasApiKey ? "••••••••" : "sk-…"}
            className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none"
          />
        </label>

        {provider !== "azure-openai" && (
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-text-2">
              Model {provider === "anthropic" && <span className="text-text-3">(kosongkan untuk default)</span>}
            </span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={provider === "anthropic" ? "claude-sonnet-5" : "nama model di endpoint ini"}
              className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none"
            />
          </label>
        )}

        {provider === "azure-openai" && (
          <>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-text-2">Azure endpoint</span>
              <input
                value={azureEndpoint}
                onChange={(e) => setAzureEndpoint(e.target.value)}
                className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-text-2">Azure deployment</span>
              <input
                value={azureDeployment}
                onChange={(e) => setAzureDeployment(e.target.value)}
                className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none"
              />
            </label>
          </>
        )}

        {provider === "openai-compatible" && (
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-text-2">Base URL</span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none"
            />
          </label>
        )}

        <div className="flex items-center gap-2.5">
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? "Menyimpan…" : "Simpan"}
          </Button>
          {saved && <span className="text-[12px] text-green">Tersimpan.</span>}
        </div>
      </Card>
    </section>
  );
}

function MailSection({ initial }: { initial: Awaited<ReturnType<typeof getIntegrationSettingsFn>>["mail"] }) {
  const router = useRouter();
  const [driver, setDriver] = useState(initial.driver ?? "resend");
  const [from, setFrom] = useState(initial.from ?? "");
  const [apiKey, setApiKey] = useState("");
  const [smtpUrl, setSmtpUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await updateMailSettingsFn({
        data: { driver, from, apiKey: apiKey || undefined, smtpUrl: smtpUrl || undefined },
      });
      setApiKey("");
      setSmtpUrl("");
      setSaved(true);
      await router.invalidate();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold">Email</h2>
      <Card className="flex flex-col gap-4 p-4">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-2">Driver</span>
          <select
            value={driver}
            onChange={(e) => setDriver(e.target.value as typeof driver)}
            className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none"
          >
            <option value="resend">Resend</option>
            <option value="brevo">Brevo</option>
            <option value="smtp">SMTP</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-2">Alamat pengirim</span>
          <input
            type="email"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="noreply@example.com"
            className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none"
          />
        </label>

        {driver === "smtp" ? (
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-text-2">
              SMTP URL {initial.hasSmtpUrl && <span className="text-text-3">(tersimpan)</span>}
            </span>
            <input
              type="password"
              value={smtpUrl}
              onChange={(e) => setSmtpUrl(e.target.value)}
              placeholder="smtp://user:pass@host:587"
              className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none"
            />
          </label>
        ) : (
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-text-2">
              API key {initial.hasApiKey && <span className="text-text-3">(tersimpan)</span>}
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none"
            />
          </label>
        )}

        <div className="flex items-center gap-2.5">
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? "Menyimpan…" : "Simpan"}
          </Button>
          {saved && <span className="text-[12px] text-green">Tersimpan.</span>}
        </div>
      </Card>
    </section>
  );
}
