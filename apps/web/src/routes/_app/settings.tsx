import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Bell, Bot, Database, KeyRound, Mail, Settings as SettingsIcon, ShieldCheck, Users, UsersRound } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { Badge } from "@kompast/ui/Badge";
import { Card } from "@kompast/ui/Card";
import { FormField, NativeSelect, TextField } from "@kompast/ui/Input";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation } from "@kompast/i18n";
import { getIntegrationSettingsFn, updateAiSettingsFn, updateMailSettingsFn, updateMicrosoftAuthFn, updateEmbeddingSettingsFn } from "@/lib/server-fns/settings";
import { listMembersFn } from "@/lib/server-fns/members";
import { listTeamsFn } from "@/lib/server-fns/teams";
import { listNotificationPrefsFn } from "@/lib/server-fns/notifications";
import { MembersTab } from "@/components/settings/MembersTab";
import { TeamsTab } from "@/components/settings/TeamsTab";
import { RolesTab } from "@/components/settings/RolesTab";
import { NotificationsTab } from "@/components/settings/NotificationsTab";
import { SettingsSection, Switch } from "@/components/settings/SettingsSection";
import { usePageChrome } from "@/components/shell/WorkbenchContext";
import { cn } from "@/lib/cn";

/** "integrations" is kept as a legacy alias (old links) and resolves to the AI section. */
const TAB_KEYS = ["notifications", "members", "teams", "roles", "integrations", "ai", "mail", "embedding", "entra"] as const;
type TabKey = (typeof TAB_KEYS)[number];

export const Route = createFileRoute("/_app/settings")({
  validateSearch: (search: Record<string, unknown>): { tab?: TabKey } => ({
    tab: TAB_KEYS.includes(search.tab as TabKey) ? (search.tab as TabKey) : undefined,
  }),
  loader: async () => {
    // Notification preferences are per-user, not admin-gated — every member
    // can see this section. The rest are owner/admin only; a non-admin who
    // hits this route directly just doesn't get that data.
    const [notificationPrefs, adminData] = await Promise.all([
      listNotificationPrefsFn(),
      Promise.all([getIntegrationSettingsFn(), listMembersFn(), listTeamsFn()])
        .then(([integrations, members, teams]) => ({ integrations, members, teams }))
        .catch(() => null),
    ]);
    return { notificationPrefs, adminData };
  },
  component: SettingsPage,
});

type Integrations = Awaited<ReturnType<typeof getIntegrationSettingsFn>>;

function SettingsPage() {
  const { t } = useTranslation("settings");
  const data = Route.useLoaderData();
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const isAdmin = data.adminData !== null;
  const requested: TabKey = tab === "integrations" ? "ai" : (tab ?? (isAdmin ? "members" : "notifications"));
  const active: TabKey = !isAdmin ? "notifications" : requested;

  const groups: { label: string; items: { key: TabKey; label: string; icon: ReactNode; status?: boolean }[] }[] = [
    { label: t("groupAccount"), items: [{ key: "notifications", label: t("tabs.notifications"), icon: <Bell size={15} /> }] },
    ...(data.adminData
      ? [
          {
            label: t("groupWorkspace"),
            items: [
              { key: "members" as const, label: t("tabs.members"), icon: <Users size={15} /> },
              { key: "teams" as const, label: t("tabs.teams"), icon: <UsersRound size={15} /> },
              { key: "roles" as const, label: t("tabs.roles"), icon: <ShieldCheck size={15} /> },
            ],
          },
          {
            label: t("groupIntegrations"),
            items: [
              { key: "ai" as const, label: t("tabs.ai"), icon: <Bot size={15} />, status: data.adminData.integrations.ai.hasApiKey && data.adminData.integrations.ai.featuresEnabled },
              { key: "mail" as const, label: t("tabs.mail"), icon: <Mail size={15} />, status: !!data.adminData.integrations.mail.from && (data.adminData.integrations.mail.hasApiKey || data.adminData.integrations.mail.hasSmtpUrl) },
              { key: "embedding" as const, label: t("tabs.embedding"), icon: <Database size={15} />, status: data.adminData.integrations.embedding.hasApiKey && data.adminData.integrations.embedding.featuresEnabled },
              { key: "entra" as const, label: t("tabs.entra"), icon: <KeyRound size={15} />, status: !!data.adminData.integrations.entra.tenantId && data.adminData.integrations.entra.hasClientSecret },
            ],
          },
        ]
      : []),
  ];
  const allItems = groups.flatMap((g) => g.items);
  const activeItem = allItems.find((i) => i.key === active);

  usePageChrome(
    {
      crumbs: [
        { label: t("pageTitle"), icon: <SettingsIcon size={15} strokeWidth={1.75} className="text-text-3" />, link: { to: "/settings" } },
        { label: activeItem?.label ?? "" },
      ],
    },
    [active, t],
  );

  const go = (key: string) => navigate({ search: { tab: key as TabKey } });

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-6 px-5 pb-16 pt-6 md:flex-row md:gap-10 md:px-8 md:pt-8">
      <nav aria-label={t("pageTitle")} className="flex-none md:w-[220px]">
        <h1 className="mb-4 type-title">{t("pageTitle")}</h1>
        <div className="md:hidden">
          <NativeSelect aria-label={t("sectionPicker")} value={active} onChange={(e) => go(e.target.value)}>
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.items.map((i) => (
                  <option key={i.key} value={i.key}>
                    {i.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </NativeSelect>
        </div>
        <div className="hidden flex-col gap-4 md:flex">
          {groups.map((g) => (
            <div key={g.label}>
              <p className="mb-1 px-2 text-[12px] font-semibold text-text-3">{g.label}</p>
              <div className="flex flex-col gap-px">
                {g.items.map((i) => (
                  <button
                    key={i.key}
                    onClick={() => go(i.key)}
                    aria-current={i.key === active ? "page" : undefined}
                    className={cn(
                      "flex h-8 items-center gap-2 rounded-[6px] px-2 text-left text-[14px] transition-colors",
                      i.key === active ? "bg-surface-4 font-medium text-text" : "text-text-2 hover:bg-surface-3 hover:text-text",
                    )}
                  >
                    <span className="text-text-3">{i.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{i.label}</span>
                    {i.status !== undefined && (
                      <span
                        title={i.status ? t("configured") : t("notConfigured")}
                        className={cn("h-1.5 w-1.5 flex-none rounded-full", i.status ? "bg-green" : "bg-border-2")}
                      />
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>

      <main className="min-w-0 flex-1">
        {active === "notifications" && <NotificationsTab data={data.notificationPrefs} />}
        {active === "members" && data.adminData && <MembersTab data={data.adminData.members} />}
        {active === "teams" && data.adminData?.integrations.isSuperAdmin && <TeamsTab teams={data.adminData.teams} members={data.adminData.members.members} />}
        {active === "teams" && data.adminData && !data.adminData.integrations.isSuperAdmin && (
          <SettingsSection title={t("tabs.teams")}>
            <p className="type-body text-text-2">{t("teamsNonAdminNote")}</p>
          </SettingsSection>
        )}
        {active === "roles" && data.adminData && <RolesTab />}
        {active === "ai" && data.adminData && <AiSection initial={data.adminData.integrations.ai} />}
        {active === "embedding" && data.adminData && <EmbeddingSection initial={data.adminData.integrations.embedding} />}
        {active === "mail" && data.adminData && <MailSection initial={data.adminData.integrations.mail} />}
        {active === "entra" && data.adminData && <EntraSection initial={data.adminData.integrations.entra} />}
      </main>
    </div>
  );
}

/** Shared save plumbing: busy flag, success toast, inline error, router refresh. */
function useSave(section: string) {
  const { t } = useTranslation("settings");
  const router = useRouter();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>) {
    setSaving(true);
    setError(null);
    try {
      await fn();
      toast.show({ title: t("savedToast", { section }) });
      await router.invalidate();
      return true;
    } catch (err) {
      setError(t("saveFailed", { message: err instanceof Error ? err.message : String(err) }));
      return false;
    } finally {
      setSaving(false);
    }
  }
  return { saving, error, run };
}

function StatusBadge({ ok }: { ok: boolean }) {
  const { t } = useTranslation("settings");
  return <Badge tone={ok ? "green" : "neutral"}>{ok ? t("configured") : t("notConfigured")}</Badge>;
}

function SecretLabel({ label, saved, note }: { label: string; saved: boolean; note: string }) {
  return (
    <span>
      {label} {saved && <span className="font-normal text-text-3">{note}</span>}
    </span>
  );
}

function SaveRow({ saving, error, onSave, disabled, label, savingLabel }: { saving: boolean; error: string | null; onSave: () => void; disabled?: boolean; label: string; savingLabel: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3">
      <Button variant="primary" onClick={onSave} disabled={saving || disabled}>
        {saving ? savingLabel : label}
      </Button>
      {error && <span className="text-[13px] text-danger">{error}</span>}
    </div>
  );
}

function EmbeddingSection({ initial }: { initial: Integrations["embedding"] }) {
  const { t } = useTranslation("settings");
  const [provider, setProvider] = useState(initial.provider ?? "azure-openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial.model ?? "");
  const [azureEndpoint, setAzureEndpoint] = useState(initial.azureEndpoint ?? "");
  const [azureDeployment, setAzureDeployment] = useState(initial.azureDeployment ?? "");
  const [baseUrl, setBaseUrl] = useState(initial.openAiCompatibleBaseUrl ?? "");
  const [enabled, setEnabled] = useState(initial.featuresEnabled);
  const { saving, error, run } = useSave(t("tabs.embedding"));

  const save = () =>
    run(async () => {
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
    });

  return (
    <SettingsSection title={t("integrations.embedding.heading")} description={t("integrations.embedding.description")} aside={<StatusBadge ok={initial.hasApiKey && initial.featuresEnabled} />}>
      <Card>
        <div className="flex flex-col gap-4 p-5">
          <Switch checked={enabled} onChange={setEnabled} label={t("integrations.embedding.enable")} />
          <FormField label={t("integrations.embedding.providerLabel")}>
            <NativeSelect value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
              <option value="azure-openai">Azure OpenAI</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </NativeSelect>
          </FormField>
          <FormField label={<SecretLabel label={t("integrations.embedding.apiKeyLabel")} saved={initial.hasApiKey} note={t("integrations.embedding.savedNoteLong")} />}>
            <TextField type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={initial.hasApiKey ? "••••••••" : "sk-…"} />
          </FormField>
          {provider === "azure-openai" ? (
            <>
              <FormField label={t("integrations.embedding.azureEndpointLabel")}>
                <TextField value={azureEndpoint} onChange={(e) => setAzureEndpoint(e.target.value)} placeholder="https://<resource>.openai.azure.com" />
              </FormField>
              <FormField label={t("integrations.embedding.azureDeploymentEmbeddingsLabel")}>
                <TextField value={azureDeployment} onChange={(e) => setAzureDeployment(e.target.value)} />
              </FormField>
            </>
          ) : (
            <>
              <FormField label={t("integrations.embedding.baseUrlLabel")}>
                <TextField value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
              </FormField>
              <FormField label={t("integrations.embedding.modelLabel")}>
                <TextField value={model} onChange={(e) => setModel(e.target.value)} placeholder="text-embedding-3-small" />
              </FormField>
            </>
          )}
        </div>
        <SaveRow saving={saving} error={error} onSave={save} label={t("integrations.embedding.save")} savingLabel={t("integrations.embedding.savingEllipsis")} />
      </Card>
    </SettingsSection>
  );
}

function EntraSection({ initial }: { initial: Integrations["entra"] }) {
  const { t } = useTranslation("settings");
  const [tenantId, setTenantId] = useState(initial.tenantId ?? "");
  const [clientId, setClientId] = useState(initial.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const { saving, error, run } = useSave(t("tabs.entra"));

  const save = () =>
    run(async () => {
      await updateMicrosoftAuthFn({ data: { tenantId: tenantId.trim(), clientId: clientId.trim(), clientSecret: clientSecret || undefined } });
      setClientSecret("");
    });

  return (
    <SettingsSection title={t("integrations.entra.heading")} description={t("integrations.entra.description")} aside={<StatusBadge ok={!!initial.tenantId && initial.hasClientSecret} />}>
      <p className="mb-4 rounded-[8px] border border-amber/30 bg-amber-soft px-4 py-3 text-[13.5px] leading-relaxed text-text">
        {t("integrations.entra.warningPart1").replace(/^⚠️\s*/, "")}
        <strong>{t("integrations.entra.warningBold")}</strong>
        {t("integrations.entra.warningPart2")}
      </p>
      <Card>
        <div className="flex flex-col gap-4 p-5">
          <FormField label={t("integrations.entra.tenantIdLabel")}>
            <TextField value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="11111111-1111-1111-1111-111111111111" className="font-mono text-[13px]" />
          </FormField>
          <FormField label={t("integrations.entra.clientIdLabel")}>
            <TextField value={clientId} onChange={(e) => setClientId(e.target.value)} className="font-mono text-[13px]" />
          </FormField>
          <FormField label={<SecretLabel label={t("integrations.entra.clientSecretLabel")} saved={initial.hasClientSecret} note={t("integrations.entra.savedNoteLong")} />}>
            <TextField type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={initial.hasClientSecret ? "••••••••" : ""} />
          </FormField>
        </div>
        <SaveRow
          saving={saving}
          error={error}
          onSave={save}
          disabled={!tenantId.trim() || !clientId.trim()}
          label={t("integrations.entra.save")}
          savingLabel={t("integrations.entra.savingEllipsis")}
        />
      </Card>
    </SettingsSection>
  );
}

function AiSection({ initial }: { initial: Integrations["ai"] }) {
  const { t } = useTranslation("settings");
  const [provider, setProvider] = useState(initial.provider ?? "anthropic");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial.model ?? "");
  const [azureEndpoint, setAzureEndpoint] = useState(initial.azureEndpoint ?? "");
  const [azureDeployment, setAzureDeployment] = useState(initial.azureDeployment ?? "");
  const [baseUrl, setBaseUrl] = useState(initial.openAiCompatibleBaseUrl ?? "");
  const [enabled, setEnabled] = useState(initial.featuresEnabled);
  const { saving, error, run } = useSave(t("tabs.ai"));

  const save = () =>
    run(async () => {
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
    });

  return (
    <SettingsSection title={t("integrations.ai.heading")} description={t("integrations.ai.description")} aside={<StatusBadge ok={initial.hasApiKey && initial.featuresEnabled} />}>
      <Card>
        <div className="flex flex-col gap-4 p-5">
          <Switch checked={enabled} onChange={setEnabled} label={t("integrations.ai.enable")} />
          <FormField label={t("integrations.ai.providerLabel")}>
            <NativeSelect value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
              <option value="anthropic">Anthropic</option>
              <option value="azure-openai">Azure OpenAI</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </NativeSelect>
          </FormField>
          <FormField label={<SecretLabel label={t("integrations.ai.apiKeyLabel")} saved={initial.hasApiKey} note={t("integrations.ai.savedNoteLong")} />}>
            <TextField type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={initial.hasApiKey ? "••••••••" : "sk-…"} />
          </FormField>
          {provider !== "azure-openai" && (
            <FormField
              label={
                <span>
                  {t("integrations.ai.modelLabel")} {provider === "anthropic" && <span className="font-normal text-text-3">{t("integrations.ai.modelBlankNote")}</span>}
                </span>
              }
            >
              <TextField value={model} onChange={(e) => setModel(e.target.value)} placeholder={provider === "anthropic" ? "claude-sonnet-5" : t("integrations.ai.modelPlaceholderOther")} />
            </FormField>
          )}
          {provider === "azure-openai" && (
            <>
              <FormField label={t("integrations.ai.azureEndpointLabel")}>
                <TextField value={azureEndpoint} onChange={(e) => setAzureEndpoint(e.target.value)} placeholder="https://<resource>.openai.azure.com" />
              </FormField>
              <FormField label={t("integrations.ai.azureDeploymentLabel")}>
                <TextField value={azureDeployment} onChange={(e) => setAzureDeployment(e.target.value)} />
              </FormField>
            </>
          )}
          {provider === "openai-compatible" && (
            <FormField label={t("integrations.ai.baseUrlLabel")}>
              <TextField value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
            </FormField>
          )}
        </div>
        <SaveRow saving={saving} error={error} onSave={save} label={t("integrations.ai.save")} savingLabel={t("integrations.ai.savingEllipsis")} />
      </Card>
    </SettingsSection>
  );
}

function MailSection({ initial }: { initial: Integrations["mail"] }) {
  const { t } = useTranslation("settings");
  const [driver, setDriver] = useState(initial.driver ?? "resend");
  const [from, setFrom] = useState(initial.from ?? "");
  const [apiKey, setApiKey] = useState("");
  const [smtpUrl, setSmtpUrl] = useState("");
  const { saving, error, run } = useSave(t("tabs.mail"));

  const save = () =>
    run(async () => {
      await updateMailSettingsFn({ data: { driver, from, apiKey: apiKey || undefined, smtpUrl: smtpUrl || undefined } });
      setApiKey("");
      setSmtpUrl("");
    });

  return (
    <SettingsSection
      title={t("integrations.mail.heading")}
      description={t("integrations.mail.description")}
      aside={<StatusBadge ok={!!initial.from && (initial.hasApiKey || initial.hasSmtpUrl)} />}
    >
      <Card>
        <div className="flex flex-col gap-4 p-5">
          <FormField label={t("integrations.mail.driverLabel")}>
            <NativeSelect value={driver} onChange={(e) => setDriver(e.target.value as typeof driver)}>
              <option value="resend">Resend</option>
              <option value="brevo">Brevo</option>
              <option value="smtp">SMTP</option>
            </NativeSelect>
          </FormField>
          <FormField label={t("integrations.mail.fromAddressLabel")}>
            <TextField type="email" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="noreply@example.com" />
          </FormField>
          {driver === "smtp" ? (
            <FormField label={<SecretLabel label={t("integrations.mail.smtpUrlLabel")} saved={initial.hasSmtpUrl} note={t("integrations.mail.savedNoteShort")} />}>
              <TextField type="password" autoComplete="off" value={smtpUrl} onChange={(e) => setSmtpUrl(e.target.value)} placeholder="smtp://user:pass@host:587" />
            </FormField>
          ) : (
            <FormField label={<SecretLabel label={t("integrations.mail.apiKeyLabel")} saved={initial.hasApiKey} note={t("integrations.mail.savedNoteShort")} />}>
              <TextField type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="••••••••" />
            </FormField>
          )}
        </div>
        <SaveRow saving={saving} error={error} onSave={save} disabled={!from.trim()} label={t("integrations.mail.save")} savingLabel={t("integrations.mail.savingEllipsis")} />
      </Card>
    </SettingsSection>
  );
}
