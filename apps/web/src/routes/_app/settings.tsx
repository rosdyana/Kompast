import { createFileRoute, redirect, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { Card } from "@kompast/ui/Card";
import { Tabs } from "@kompast/ui/Tabs";
import { PageContainer } from "@kompast/ui/PageContainer";
import { PageHeader } from "@kompast/ui/PageHeader";
import { useTranslation } from "@kompast/i18n";
import { getIntegrationSettingsFn, updateAiSettingsFn, updateMailSettingsFn, updateMicrosoftAuthFn, updateEmbeddingSettingsFn } from "@/lib/server-fns/settings";
import { listMembersFn } from "@/lib/server-fns/members";
import { listTeamsFn } from "@/lib/server-fns/teams";
import { MembersTab } from "@/components/settings/MembersTab";
import { TeamsTab } from "@/components/settings/TeamsTab";
import { RolesTab } from "@/components/settings/RolesTab";

const TAB_KEYS = ["members", "teams", "roles", "integrations"] as const;
type TabKey = (typeof TAB_KEYS)[number];

export const Route = createFileRoute("/_app/settings")({
  validateSearch: (search: Record<string, unknown>): { tab?: TabKey } => ({
    tab: TAB_KEYS.includes(search.tab as TabKey) ? (search.tab as TabKey) : undefined,
  }),
  loader: async () => {
    try {
      const [integrations, members, teams] = await Promise.all([getIntegrationSettingsFn(), listMembersFn(), listTeamsFn()]);
      return { integrations, members, teams };
    } catch {
      // Not an owner/admin — the sidebar already hides this link for
      // non-admins, but someone can still type the URL directly.
      throw redirect({ to: "/" });
    }
  },
  component: SettingsPage,
});

function SettingsPage() {
  const { t } = useTranslation("settings");
  const data = Route.useLoaderData();
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const active: TabKey = tab ?? "members";

  const items = [
    { key: "members", label: t("tabs.members") },
    { key: "teams", label: t("tabs.teams") },
    { key: "roles", label: t("tabs.roles") },
    { key: "integrations", label: t("tabs.integrations") },
  ];

  return (
    <PageContainer width="wide">
      <PageHeader title={t("pageTitle")} />
      <Tabs items={items} active={active} onChange={(key) => navigate({ search: { tab: key as TabKey } })} className="mb-6 border-b border-border" />

      {active === "members" && <MembersTab data={data.members} />}
      {active === "teams" && data.integrations.isSuperAdmin && <TeamsTab teams={data.teams} members={data.members.members} />}
      {active === "teams" && !data.integrations.isSuperAdmin && (
        <p className="type-body text-text-3">{t("teamsNonAdminNote")}</p>
      )}
      {active === "roles" && <RolesTab />}
      {active === "integrations" && <IntegrationsTab data={data.integrations} />}
    </PageContainer>
  );
}

function IntegrationsTab({ data }: { data: Awaited<ReturnType<typeof getIntegrationSettingsFn>> }) {
  const { t } = useTranslation("settings");
  return (
    <div>
      <p className="mb-6 type-body text-text-2">{t("integrations.subtitle")}</p>
      <Card className="divide-y divide-border overflow-hidden">
        <EntraSection initial={data.entra} />
        <AiSection initial={data.ai} />
        <EmbeddingSection initial={data.embedding} />
        <MailSection initial={data.mail} />
      </Card>
    </div>
  );
}

function EmbeddingSection({ initial }: { initial: Awaited<ReturnType<typeof getIntegrationSettingsFn>>["embedding"] }) {
  const { t } = useTranslation("settings");
  const router = useRouter();
  const [provider, setProvider] = useState(initial.provider ?? "azure-openai");
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
      await updateEmbeddingSettingsFn({
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
    <div className="p-4">
      <h2 className="mb-3 type-headline">{t("integrations.embedding.heading")}</h2>
      <p className="mb-3 type-body text-text-2">{t("integrations.embedding.description")}</p>
      <div className="flex flex-col gap-4">
        <label className="flex items-center gap-2 type-body">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t("integrations.embedding.enable")}
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-2">{t("integrations.embedding.providerLabel")}</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as typeof provider)}
            className="kp-select w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
          >
            <option value="azure-openai">Azure OpenAI</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-2">
            {t("integrations.embedding.apiKeyLabel")} {initial.hasApiKey && <span className="text-text-3">{t("integrations.embedding.savedNoteLong")}</span>}
          </span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={initial.hasApiKey ? "••••••••" : "sk-…"}
            className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
          />
        </label>

        {provider === "azure-openai" ? (
          <>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-text-2">{t("integrations.embedding.azureEndpointLabel")}</span>
              <input
                value={azureEndpoint}
                onChange={(e) => setAzureEndpoint(e.target.value)}
                className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-text-2">{t("integrations.embedding.azureDeploymentEmbeddingsLabel")}</span>
              <input
                value={azureDeployment}
                onChange={(e) => setAzureDeployment(e.target.value)}
                className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
              />
            </label>
          </>
        ) : (
          <>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-text-2">{t("integrations.embedding.baseUrlLabel")}</span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-text-2">{t("integrations.embedding.modelLabel")}</span>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="text-embedding-3-small"
                className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
              />
            </label>
          </>
        )}

        <div className="flex items-center gap-2.5">
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? t("integrations.embedding.savingEllipsis") : t("integrations.embedding.save")}
          </Button>
          {saved && <span className="type-body text-green">{t("integrations.embedding.saved")}</span>}
        </div>
      </div>
    </div>
  );
}

function EntraSection({ initial }: { initial: Awaited<ReturnType<typeof getIntegrationSettingsFn>>["entra"] }) {
  const { t } = useTranslation("settings");
  const router = useRouter();
  const [tenantId, setTenantId] = useState(initial.tenantId ?? "");
  const [clientId, setClientId] = useState(initial.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await updateMicrosoftAuthFn({ data: { tenantId: tenantId.trim(), clientId: clientId.trim(), clientSecret: clientSecret || undefined } });
      setClientSecret("");
      setSaved(true);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("integrations.entra.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-4">
      <h2 className="mb-3 type-headline">{t("integrations.entra.heading")}</h2>
      <div className="flex flex-col gap-4">
        <p className="rounded-[7px] border border-dashed border-border-2 bg-surface-2 p-3 type-body leading-relaxed text-text-2">
          {t("integrations.entra.warningPart1")}
          <strong>{t("integrations.entra.warningBold")}</strong>
          {t("integrations.entra.warningPart2")}
        </p>
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-2">{t("integrations.entra.tenantIdLabel")}</span>
          <input
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            placeholder="11111111-1111-1111-1111-111111111111"
            className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-2">{t("integrations.entra.clientIdLabel")}</span>
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-2">
            {t("integrations.entra.clientSecretLabel")} {initial.hasClientSecret && <span className="text-text-3">{t("integrations.entra.savedNoteLong")}</span>}
          </span>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={initial.hasClientSecret ? "••••••••" : ""}
            className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
          />
        </label>
        <div className="flex items-center gap-2.5">
          <Button variant="primary" onClick={save} disabled={saving || !tenantId.trim() || !clientId.trim()}>
            {saving ? t("integrations.entra.savingEllipsis") : t("integrations.entra.save")}
          </Button>
          {saved && <span className="type-body text-green">{t("integrations.entra.saved")}</span>}
          {error && <span className="type-body text-danger">{error}</span>}
        </div>
      </div>
    </div>
  );
}

function AiSection({ initial }: { initial: Awaited<ReturnType<typeof getIntegrationSettingsFn>>["ai"] }) {
  const { t } = useTranslation("settings");
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
    <div className="p-4">
      <h2 className="mb-3 type-headline">{t("integrations.ai.heading")}</h2>
      <div className="flex flex-col gap-4">
        <label className="flex items-center gap-2 type-body">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t("integrations.ai.enable")}
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-2">{t("integrations.ai.providerLabel")}</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as typeof provider)}
            className="kp-select w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
          >
            <option value="anthropic">Anthropic</option>
            <option value="azure-openai">Azure OpenAI</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-2">
            {t("integrations.ai.apiKeyLabel")} {initial.hasApiKey && <span className="text-text-3">{t("integrations.ai.savedNoteLong")}</span>}
          </span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={initial.hasApiKey ? "••••••••" : "sk-…"}
            className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
          />
        </label>

        {provider !== "azure-openai" && (
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-text-2">
              {t("integrations.ai.modelLabel")} {provider === "anthropic" && <span className="text-text-3">{t("integrations.ai.modelBlankNote")}</span>}
            </span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={provider === "anthropic" ? "claude-sonnet-5" : t("integrations.ai.modelPlaceholderOther")}
              className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
            />
          </label>
        )}

        {provider === "azure-openai" && (
          <>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-text-2">{t("integrations.ai.azureEndpointLabel")}</span>
              <input
                value={azureEndpoint}
                onChange={(e) => setAzureEndpoint(e.target.value)}
                className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-text-2">{t("integrations.ai.azureDeploymentLabel")}</span>
              <input
                value={azureDeployment}
                onChange={(e) => setAzureDeployment(e.target.value)}
                className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
              />
            </label>
          </>
        )}

        {provider === "openai-compatible" && (
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-text-2">{t("integrations.ai.baseUrlLabel")}</span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
            />
          </label>
        )}

        <div className="flex items-center gap-2.5">
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? t("integrations.ai.savingEllipsis") : t("integrations.ai.save")}
          </Button>
          {saved && <span className="type-body text-green">{t("integrations.ai.saved")}</span>}
        </div>
      </div>
    </div>
  );
}

function MailSection({ initial }: { initial: Awaited<ReturnType<typeof getIntegrationSettingsFn>>["mail"] }) {
  const { t } = useTranslation("settings");
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
    <div className="p-4">
      <h2 className="mb-3 type-headline">{t("integrations.mail.heading")}</h2>
      <div className="flex flex-col gap-4">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-2">{t("integrations.mail.driverLabel")}</span>
          <select
            value={driver}
            onChange={(e) => setDriver(e.target.value as typeof driver)}
            className="kp-select w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
          >
            <option value="resend">Resend</option>
            <option value="brevo">Brevo</option>
            <option value="smtp">SMTP</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-2">{t("integrations.mail.fromAddressLabel")}</span>
          <input
            type="email"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="noreply@example.com"
            className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
          />
        </label>

        {driver === "smtp" ? (
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-text-2">
              {t("integrations.mail.smtpUrlLabel")} {initial.hasSmtpUrl && <span className="text-text-3">{t("integrations.mail.savedNoteShort")}</span>}
            </span>
            <input
              type="password"
              value={smtpUrl}
              onChange={(e) => setSmtpUrl(e.target.value)}
              placeholder="smtp://user:pass@host:587"
              className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
            />
          </label>
        ) : (
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-text-2">
              {t("integrations.mail.apiKeyLabel")} {initial.hasApiKey && <span className="text-text-3">{t("integrations.mail.savedNoteShort")}</span>}
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
            />
          </label>
        )}

        <div className="flex items-center gap-2.5">
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? t("integrations.mail.savingEllipsis") : t("integrations.mail.save")}
          </Button>
          {saved && <span className="type-body text-green">{t("integrations.mail.saved")}</span>}
        </div>
      </div>
    </div>
  );
}
