import { createFileRoute, useLoaderData, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bell, Bot, Building2, CheckCircle2, Clock, Database, FileLock2, KeyRound, Mail, Settings as SettingsIcon, Users, UsersRound, XCircle } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { Badge } from "@kompast/ui/Badge";
import { Card } from "@kompast/ui/Card";
import { FormField, NativeSelect, TextField } from "@kompast/ui/Input";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation } from "@kompast/i18n";
import {
  getIntegrationSettingsFn,
  updateAiSettingsFn,
  updateMailSettingsFn,
  updateMicrosoftAuthFn,
  testMicrosoftAuthFn,
  updateEmbeddingSettingsFn,
  reindexAllFn,
  sendTestEmailFn,
  getTestEmailStatusFn,
  testAiProviderFn,
  testEmbeddingProviderFn,
  getEmbeddingStatusFn,
  retryFailedReindexFn,
  retryWaitingReindexNowFn,
} from "@/lib/server-fns/settings";
import { listMembersFn } from "@/lib/server-fns/members";
import { listTeamsFn } from "@/lib/server-fns/teams";
import { renameWorkspaceFn } from "@/lib/server-fns/workspace";
import { listNotificationPrefsFn } from "@/lib/server-fns/notifications";
import { MembersTab } from "@/components/settings/MembersTab";
import { TeamsTab } from "@/components/settings/TeamsTab";
import { NotificationsTab } from "@/components/settings/NotificationsTab";
import { DepartedPagesTab } from "@/components/settings/DepartedPagesTab";
import { SettingsSection, Switch } from "@/components/settings/SettingsSection";
import { usePageChrome } from "@/components/shell/WorkbenchContext";
import { cn } from "@/lib/cn";

/** "integrations" and "roles" are legacy aliases (old links): they resolve to the AI and Members sections. */
const TAB_KEYS = ["notifications", "general", "members", "teams", "roles", "departedPages", "integrations", "ai", "mail", "embedding", "entra"] as const;
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

type Integrations = NonNullable<Awaited<ReturnType<typeof getIntegrationSettingsFn>>["global"]>;

function SettingsPage() {
  const { t } = useTranslation("settings");
  const data = Route.useLoaderData();
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const isAdmin = data.adminData !== null;
  const globalSettings = data.adminData?.integrations.global ?? null;
  const requested: TabKey = tab === "integrations" ? "ai" : tab === "roles" ? "members" : (tab ?? (isAdmin ? "general" : "notifications"));
  const isGlobalTab = requested === "ai" || requested === "mail" || requested === "embedding" || requested === "entra";
  const active: TabKey = !isAdmin ? "notifications" : isGlobalTab && !globalSettings ? "general" : requested;

  const groups: { label: string; items: { key: TabKey; label: string; icon: ReactNode; status?: boolean }[] }[] = [
    { label: t("groupAccount"), items: [{ key: "notifications", label: t("tabs.notifications"), icon: <Bell size={15} /> }] },
    ...(data.adminData
      ? [
          {
            label: t("groupWorkspace"),
            items: [
              { key: "general" as const, label: t("tabs.general"), icon: <Building2 size={15} /> },
              { key: "members" as const, label: t("tabs.members"), icon: <Users size={15} /> },
              { key: "teams" as const, label: t("tabs.teams"), icon: <UsersRound size={15} /> },
              ...(data.adminData.integrations.isSuperAdmin
                ? [{ key: "departedPages" as const, label: t("tabs.departedPages"), icon: <FileLock2 size={15} /> }]
                : []),
            ],
          },
        ]
      : []),
    // Deployment-wide config — only the deployment admin gets it (see getIntegrationSettingsFn).
    ...(globalSettings
      ? [
          {
            label: t("groupIntegrations"),
            items: [
              { key: "ai" as const, label: t("tabs.ai"), icon: <Bot size={15} />, status: globalSettings.ai.hasApiKey && globalSettings.ai.featuresEnabled },
              { key: "mail" as const, label: t("tabs.mail"), icon: <Mail size={15} />, status: !!globalSettings.mail.from && (globalSettings.mail.hasApiKey || globalSettings.mail.hasSmtpUrl) },
              { key: "embedding" as const, label: t("tabs.embedding"), icon: <Database size={15} />, status: globalSettings.embedding.hasApiKey && globalSettings.embedding.featuresEnabled },
              { key: "entra" as const, label: t("tabs.entra"), icon: <KeyRound size={15} />, status: !!globalSettings.entra.tenantId && globalSettings.entra.hasClientSecret },
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
        {active === "general" && data.adminData && <WorkspaceSection />}
        {active === "members" && data.adminData && <MembersTab data={data.adminData.members} />}
        {active === "teams" && data.adminData?.integrations.isSuperAdmin && <TeamsTab teams={data.adminData.teams} members={data.adminData.members.members} />}
        {active === "teams" && data.adminData && !data.adminData.integrations.isSuperAdmin && (
          <SettingsSection title={t("tabs.teams")}>
            <p className="type-body text-text-2">{t("teamsNonAdminNote")}</p>
          </SettingsSection>
        )}
        {active === "departedPages" && data.adminData?.integrations.isSuperAdmin && <DepartedPagesTab />}
        {active === "ai" && globalSettings && <AiSection initial={globalSettings.ai} />}
        {active === "embedding" && globalSettings && <EmbeddingSection initial={globalSettings.embedding} />}
        {active === "mail" && globalSettings && <MailSection initial={globalSettings.mail} userEmail={data.adminData?.integrations.userEmail ?? ""} />}
        {active === "entra" && globalSettings && <EntraSection initial={globalSettings.entra} />}
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

function TestEmailResultLine({ result }: { result: TestEmailResult }) {
  const { t } = useTranslation("settings");
  if (result.kind === "sent") {
    return (
      <p className="flex items-start gap-2 text-[13px] text-green">
        <CheckCircle2 size={15} className="mt-px flex-none" />
        <span>{t("integrations.mail.test.sent")}</span>
      </p>
    );
  }
  if (result.kind === "failed") {
    return (
      <p className="flex items-start gap-2 text-[13px] text-danger">
        <XCircle size={15} className="mt-px flex-none" />
        <span className="break-words">{t("integrations.mail.test.failed", { error: result.error ?? t("integrations.mail.test.unknownError") })}</span>
      </p>
    );
  }
  if (result.kind === "queued") {
    return (
      <p className="flex items-start gap-2 text-[13px] text-amber">
        <Clock size={15} className="mt-px flex-none" />
        <span>{t("integrations.mail.test.stillQueued")}</span>
      </p>
    );
  }
  return <p className="text-[13px] text-danger">{t("integrations.mail.test.error", { message: result.message })}</p>;
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

function SaveRow({
  saving,
  error,
  onSave,
  disabled,
  label,
  savingLabel,
  testButton,
}: {
  saving: boolean;
  error: string | null;
  onSave: () => void;
  disabled?: boolean;
  label: string;
  savingLabel: string;
  /** Optional "Test connection" button, shown next to Save. */
  testButton?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3">
      <Button variant="primary" onClick={onSave} disabled={saving || disabled}>
        {saving ? savingLabel : label}
      </Button>
      {testButton}
      {error && <span className="text-[13px] text-danger">{error}</span>}
    </div>
  );
}

/**
 * A provider test result, as the server functions return it. `thrown` marks a
 * test that never reached the provider (a server-side refusal or a network
 * failure of the app itself), so it gets no status hint.
 */
type ConnectionTest =
  | { ok: true; model: string; latencyMs: number; dimensions?: number }
  | { ok: false; status?: number; message: string; thrown?: boolean };

/** Runs a provider test and keeps its result. Errors from the server function are shown as a failed test, not left to the global error page. */
function useConnectionTest(run: () => Promise<ConnectionTest>) {
  const { t } = useTranslation("settings");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionTest | null>(null);
  const start = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await run());
    } catch (err) {
      setResult({ ok: false, thrown: true, message: t("integrations.test.requestFailed", { message: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setTesting(false);
    }
  };
  return { testing, result, start };
}

/** Shown beside Save. Disabled while the form is saving, and while its own test is running. */
function TestConnectionButton({ testing, disabled, onClick }: { testing: boolean; disabled: boolean; onClick: () => void }) {
  const { t } = useTranslation("settings");
  return (
    <Button variant="secondary" onClick={onClick} disabled={testing || disabled}>
      {testing ? t("integrations.test.testing") : t("integrations.test.button")}
    </Button>
  );
}

/** The result block under a form: a green success line, or the provider's status, a hint for it, and its exact message in a monospace box. */
function ConnectionTestResultView({ result, embedding }: { result: ConnectionTest; embedding: boolean }) {
  const { t } = useTranslation("settings");
  if (result.ok) {
    return (
      <p className="flex items-start gap-2 text-[13px] text-green">
        <CheckCircle2 size={15} className="mt-px flex-none" />
        <span className="break-words">
          {embedding
            ? t("integrations.test.okEmbedding", { model: result.model, dimensions: result.dimensions, latencyMs: result.latencyMs })
            : t("integrations.test.okAi", { model: result.model, latencyMs: result.latencyMs })}
        </span>
      </p>
    );
  }

  const status = result.thrown ? undefined : result.status;
  // Hints only for statuses that have a clear next step. A test that never got an HTTP status (network, or a refused configuration) gets the network hint.
  const hint =
    result.thrown
      ? null
      : status === undefined
        ? t("integrations.test.hintNetwork")
        : status === 401 || status === 403
          ? t("integrations.test.hintAuth")
          : status === 404
            ? t("integrations.test.hintNotFound")
            : status === 400
              ? t("integrations.test.hintBadRequest")
              : status === 429
                ? t("integrations.test.hintRateLimit")
                : null;

  return (
    <div className="flex flex-col gap-2 text-[13px]">
      <p className="flex items-start gap-2 font-medium text-danger">
        <XCircle size={15} className="mt-px flex-none" />
        <span>{status !== undefined ? `${t("integrations.test.failed")} · ${t("integrations.test.status", { status })}` : t("integrations.test.failed")}</span>
      </p>
      {hint && <p className="text-text-2">{hint}</p>}
      {!result.thrown && (
        <div className="flex flex-col gap-1">
          <p className="text-[12px] text-text-3">{t("integrations.test.responseLabel")}</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[6px] bg-surface-3 px-3 py-2 font-mono text-[12px] leading-relaxed text-text-2">
            {result.message}
          </pre>
        </div>
      )}
      {result.thrown && <p className="break-words text-text-2">{result.message}</p>}
    </div>
  );
}

function WorkspaceSection() {
  const { t } = useTranslation("settings");
  const shell = useLoaderData({ from: "/_app" });
  const current = shell?.organization?.name ?? "";
  const [name, setName] = useState(current);
  const { saving, error, run } = useSave(t("tabs.general"));
  const trimmed = name.trim();

  return (
    <SettingsSection title={t("general.heading")} description={t("general.description")}>
      <Card>
        <div className="flex flex-col gap-4 p-5">
          <FormField label={t("general.nameLabel")} hint={t("general.nameHint")}>
            <TextField value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </FormField>
        </div>
        <SaveRow
          saving={saving}
          error={error}
          onSave={() => run(() => renameWorkspaceFn({ data: { name: trimmed } }))}
          disabled={!trimmed || trimmed === current}
          label={t("general.save")}
          savingLabel={t("general.savingEllipsis")}
        />
      </Card>
    </SettingsSection>
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
  // Bumped after a reindex is queued, so the status panel refetches and starts polling the new work.
  const [statusVersion, setStatusVersion] = useState(0);

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

  // Tests the values currently in the form, the same fields Save sends, so it works before Save.
  const connection = useConnectionTest(() =>
    testEmbeddingProviderFn({
      data: {
        provider,
        apiKey: apiKey || undefined,
        model: model || undefined,
        azureEndpoint: azureEndpoint || undefined,
        azureDeployment: azureDeployment || undefined,
        openAiCompatibleBaseUrl: baseUrl || undefined,
      },
    }),
  );

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
        <SaveRow
          saving={saving}
          error={error}
          onSave={save}
          label={t("integrations.embedding.save")}
          savingLabel={t("integrations.embedding.savingEllipsis")}
          testButton={<TestConnectionButton testing={connection.testing} disabled={saving} onClick={connection.start} />}
        />
        {connection.result && (
          <div className="border-t border-border px-5 py-3">
            <ConnectionTestResultView result={connection.result} embedding />
          </div>
        )}
      </Card>
      <EmbeddingStatusCard refreshKey={statusVersion} />
      <ReindexCard onQueued={() => setStatusVersion((v) => v + 1)} />
    </SettingsSection>
  );
}

/** Queues every issue, comment and page for re-embedding. Separate from the form above: it saves nothing and needs no unsaved-changes check. */
function ReindexCard({ onQueued }: { onQueued: () => void }) {
  const { t } = useTranslation("settings");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ issues: number; comments: number; pages: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reindex = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { issues, comments, pages } = await reindexAllFn();
      setResult({ issues, comments, pages });
      onQueued();
    } catch (err) {
      setError(t("integrations.embedding.reindexFailed", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-4">
      <div className="flex flex-col gap-2 p-5">
        <p className="text-[13px] leading-relaxed text-text-2">{t("integrations.embedding.reindexHelp")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3">
        <Button variant="secondary" onClick={reindex} disabled={busy}>
          {busy ? t("integrations.embedding.reindexing") : t("integrations.embedding.reindex")}
        </Button>
        {result && (
          <span className="text-[13px] text-text-2">
            {t("integrations.embedding.reindexQueued", { issues: result.issues, comments: result.comments, pages: result.pages })}
          </span>
        )}
        {error && <span className="text-[13px] text-danger">{error}</span>}
      </div>
    </Card>
  );
}

type EmbeddingStatusView = Awaited<ReturnType<typeof getEmbeddingStatusFn>>;

/** While anything is pending or processing, the status is refetched this often. */
const EMBEDDING_STATUS_POLL_MS = 5000;
/** Longest failure message shown in the table. The full text is in the cell's title. */
const FAILURE_PREVIEW_CHARS = 160;

function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 12)}…` : value;
}

function previewText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Indexing progress for the embedding index: indexed counts per type, queue
 * counts, recent failures with a retry button. Polls while work is pending or
 * processing, and otherwise waits for a manual refresh. `refreshKey` changes
 * when a reindex is queued, so the card loads the new work right away.
 */
function EmbeddingStatusCard({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<EmbeddingStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const [retryingNow, setRetryingNow] = useState(false);
  const [retryNowMessage, setRetryNowMessage] = useState<string | null>(null);
  // One fetch at a time: an interval tick that lands during a slow fetch is
  // folded into a single follow-up fetch, not stacked — and not dropped, so a
  // refresh asked for after "Retry failed" always shows post-retry numbers.
  const inFlight = useRef(false);
  const refreshAgain = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      refreshAgain.current = true;
      return;
    }
    inFlight.current = true;
    setLoading(true);
    try {
      do {
        refreshAgain.current = false;
        try {
          const next = await getEmbeddingStatusFn();
          if (!aliveRef.current) return;
          setStatus(next);
          setError(null);
        } catch (err) {
          if (aliveRef.current) setError(t("integrations.embedding.status.loadFailed", { message: err instanceof Error ? err.message : String(err) }));
        }
      } while (refreshAgain.current && aliveRef.current);
    } finally {
      inFlight.current = false;
      if (aliveRef.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const pendingOrProcessing = status ? status.queue.pending + status.queue.processing : 0;
  const polling = pendingOrProcessing > 0;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void refresh(), EMBEDDING_STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, refresh]);

  const retryFailed = async () => {
    setRetrying(true);
    setRetryMessage(null);
    try {
      const { reset } = await retryFailedReindexFn();
      setRetryMessage(t("integrations.embedding.status.retryDone", { count: reset }));
      await refresh();
    } catch (err) {
      if (aliveRef.current) setRetryMessage(t("integrations.embedding.status.retryFailedError", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      if (aliveRef.current) setRetrying(false);
    }
  };

  const retryWaitingNow = async () => {
    setRetryingNow(true);
    setRetryNowMessage(null);
    try {
      const { moved } = await retryWaitingReindexNowFn();
      setRetryNowMessage(t("integrations.embedding.status.retryNowDone", { count: moved }));
      await refresh();
    } catch (err) {
      if (aliveRef.current) setRetryNowMessage(t("integrations.embedding.status.retryNowError", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      if (aliveRef.current) setRetryingNow(false);
    }
  };

  const ageLabel = (seconds: number) =>
    seconds < 60
      ? t("integrations.embedding.status.age.seconds", { count: seconds })
      : seconds < 3600
        ? t("integrations.embedding.status.age.minutes", { count: Math.floor(seconds / 60) })
        : t("integrations.embedding.status.age.hours", { count: Math.floor(seconds / 3600) });

  const indexedRows: { key: "issue" | "comment" | "page"; label: string }[] = [
    { key: "issue", label: t("integrations.embedding.status.issues") },
    { key: "comment", label: t("integrations.embedding.status.comments") },
    { key: "page", label: t("integrations.embedding.status.docs") },
  ];
  const typeLabel = (entityType: string) =>
    entityType === "issue"
      ? t("integrations.embedding.status.types.issue")
      : entityType === "comment"
        ? t("integrations.embedding.status.types.comment")
        : t("integrations.embedding.status.types.page");

  return (
    <Card className="mt-4">
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium">{t("integrations.embedding.status.heading")}</p>
            <p className="mt-0.5 text-[13px] text-text-3">{t("integrations.embedding.status.description")}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? t("integrations.embedding.status.refreshing") : t("integrations.embedding.status.refresh")}
          </Button>
        </div>

        {error && <p className="text-[13px] text-danger">{error}</p>}
        {!status && !error && <p className="text-[13px] text-text-3">{t("integrations.embedding.status.refreshing")}</p>}
        {status && !status.configured && <p className="text-[13px] text-text-2">{t("integrations.embedding.status.notConfigured")}</p>}

        {status?.configured && (
          <>
            {status.queue.workerStalled && status.queue.oldestReadyAgeSeconds !== null && (
              <p className="rounded-[8px] border border-amber/30 bg-amber-soft px-4 py-3 text-[13.5px] leading-relaxed text-text">
                {t("integrations.embedding.status.stalled", { age: ageLabel(status.queue.oldestReadyAgeSeconds) })}
              </p>
            )}
            <div className="flex flex-col gap-3">
              <p className="type-small font-medium text-text-2">{t("integrations.embedding.status.indexed")}</p>
              {indexedRows.map(({ key, label }) => {
                const { indexed, total } = status.indexed[key];
                const pct = total === 0 ? 100 : Math.min(100, Math.round((indexed / total) * 100));
                return (
                  <div key={key} className="flex flex-col gap-1">
                    <div className="flex items-center justify-between text-[13px]">
                      <span className="text-text-2">{label}</span>
                      <span className="tabular-nums text-text-2">
                        {indexed} / {total}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                      <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-col gap-2">
              <p className="type-small font-medium text-text-2">{t("integrations.embedding.status.queue")}</p>
              <div className="grid grid-cols-3 gap-3 text-[13px]">
                <div className="flex flex-col gap-0.5">
                  <span className="text-text-3">{t("integrations.embedding.status.pending")}</span>
                  <span className="tabular-nums text-text">{status.queue.pending}</span>
                  {status.queue.oldestPendingAgeSeconds !== null && (
                    <span className="text-[12px] text-text-3">{t("integrations.embedding.status.oldestPending", { age: ageLabel(status.queue.oldestPendingAgeSeconds) })}</span>
                  )}
                  {status.queue.waitingRetry > 0 && (
                    <span className="text-[12px] text-amber">{t("integrations.embedding.status.waitingRetry", { count: status.queue.waitingRetry })}</span>
                  )}
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-text-3">{t("integrations.embedding.status.processing")}</span>
                  <span className="tabular-nums text-text">{status.queue.processing}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-text-3">{t("integrations.embedding.status.failed")}</span>
                  <span className={cn("tabular-nums", status.queue.failed > 0 ? "text-danger" : "text-text")}>{status.queue.failed}</span>
                </div>
              </div>
            </div>

            {status.recentRetries.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="type-small font-medium text-text-2">{t("integrations.embedding.status.retries")}</p>
                  <Button variant="secondary" size="sm" onClick={retryWaitingNow} disabled={retryingNow}>
                    {t("integrations.embedding.status.retryNow")}
                  </Button>
                </div>
                <p className="text-[12px] text-text-3">{t("integrations.embedding.status.retriesHint", { max: status.queue.maxAttempts })}</p>
                {retryNowMessage && <p className="text-[13px] text-text-2">{retryNowMessage}</p>}
                <div className="overflow-x-auto rounded-[8px] border border-border">
                  <table className="w-full text-left text-[13px]">
                    <thead className="bg-surface-2 text-[12px] text-text-3">
                      <tr>
                        <th className="px-3 py-2 font-medium">{t("integrations.embedding.status.colType")}</th>
                        <th className="px-3 py-2 font-medium">{t("integrations.embedding.status.colItem")}</th>
                        <th className="px-3 py-2 font-medium">{t("integrations.embedding.status.colAttempts")}</th>
                        <th className="px-3 py-2 font-medium">{t("integrations.embedding.status.colNextTry")}</th>
                        <th className="px-3 py-2 font-medium">{t("integrations.embedding.status.colError")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {status.recentRetries.map((r) => (
                        <tr key={r.id}>
                          <td className="px-3 py-2 align-top text-text-2">{typeLabel(r.entityType)}</td>
                          <td className="px-3 py-2 align-top font-mono text-[12px] text-text-3" title={r.entityId}>
                            {shortId(r.entityId)}
                          </td>
                          <td className="px-3 py-2 align-top tabular-nums text-text-2">{r.attempts}</td>
                          <td className="px-3 py-2 align-top whitespace-nowrap text-text-2">
                            {r.nextAttemptInSeconds === 0
                              ? t("integrations.embedding.status.nextTryNow")
                              : t("integrations.embedding.status.nextTryIn", { age: ageLabel(r.nextAttemptInSeconds) })}
                          </td>
                          <td className="px-3 py-2 align-top font-mono text-[12px] text-amber" title={r.error ?? undefined}>
                            {r.error ? previewText(r.error, FAILURE_PREVIEW_CHARS) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="type-small font-medium text-text-2">{t("integrations.embedding.status.failures")}</p>
                <Button variant="secondary" size="sm" onClick={retryFailed} disabled={retrying || status.queue.failed === 0}>
                  {t("integrations.embedding.status.retryFailed")}
                </Button>
              </div>
              {retryMessage && <p className="text-[13px] text-text-2">{retryMessage}</p>}
              {status.recentFailures.length === 0 ? (
                <p className="text-[13px] text-text-3">{t("integrations.embedding.status.noFailures")}</p>
              ) : (
                <div className="overflow-x-auto rounded-[8px] border border-border">
                  <table className="w-full text-left text-[13px]">
                    <thead className="bg-surface-2 text-[12px] text-text-3">
                      <tr>
                        <th className="px-3 py-2 font-medium">{t("integrations.embedding.status.colType")}</th>
                        <th className="px-3 py-2 font-medium">{t("integrations.embedding.status.colItem")}</th>
                        <th className="px-3 py-2 font-medium">{t("integrations.embedding.status.colAttempts")}</th>
                        <th className="px-3 py-2 font-medium">{t("integrations.embedding.status.colError")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {status.recentFailures.map((f) => (
                        <tr key={f.id}>
                          <td className="px-3 py-2 align-top text-text-2">{typeLabel(f.entityType)}</td>
                          <td className="px-3 py-2 align-top font-mono text-[12px] text-text-3" title={f.entityId}>
                            {shortId(f.entityId)}
                          </td>
                          <td className="px-3 py-2 align-top tabular-nums text-text-2">{f.attempts}</td>
                          <td className="px-3 py-2 align-top font-mono text-[12px] text-danger" title={f.error ?? undefined}>
                            {f.error ? previewText(f.error, FAILURE_PREVIEW_CHARS) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

/** The Entra test's own result, shown under the form. Kept apart from ConnectionTest, whose ok shape carries AI model fields. */
type EntraTestResult = { ok: true; warning?: string } | { ok: false; message: string };

function EntraSection({ initial }: { initial: Integrations["entra"] }) {
  const { t } = useTranslation("settings");
  const [tenantId, setTenantId] = useState(initial.tenantId ?? "");
  const [clientId, setClientId] = useState(initial.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const { saving, error, run } = useSave(t("tabs.entra"));
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<EntraTestResult | null>(null);

  const save = () =>
    run(async () => {
      await updateMicrosoftAuthFn({ data: { tenantId: tenantId.trim(), clientId: clientId.trim(), clientSecret: clientSecret || undefined } });
      setClientSecret("");
    });

  // Checks the values currently in the form against Microsoft, the same fields Save sends, and saves nothing.
  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testMicrosoftAuthFn({ data: { tenantId: tenantId.trim(), clientId: clientId.trim(), clientSecret: clientSecret || undefined } }));
    } catch (err) {
      setTestResult({ ok: false, message: t("integrations.test.requestFailed", { message: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsSection title={t("integrations.entra.heading")} description={t("integrations.entra.description")} aside={<StatusBadge ok={!!initial.tenantId && initial.hasClientSecret} />}>
      {initial.signInStatus === "unavailable" && (
        <p className="mb-4 rounded-[8px] border border-danger/30 bg-danger/10 px-4 py-3 text-[13.5px] leading-relaxed text-danger">{t("integrations.entra.signInBroken")}</p>
      )}
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
          testButton={<TestConnectionButton testing={testing} disabled={!tenantId.trim() || !clientId.trim()} onClick={test} />}
        />
        {testResult && <EntraTestResultLine result={testResult} />}
      </Card>
    </SettingsSection>
  );
}

function EntraTestResultLine({ result }: { result: EntraTestResult }) {
  const { t } = useTranslation("settings");
  if (!result.ok) {
    return (
      <p className="flex items-start gap-2 border-t border-border px-5 py-3 text-[13px] text-danger">
        <XCircle size={15} className="mt-px flex-none" />
        <span className="break-words">{result.message}</span>
      </p>
    );
  }
  if (result.warning) {
    // Microsoft refused the test token for a reason that doesn't block saving (see verifyMicrosoftEntraConfig). Shown as-is, in English.
    return (
      <p className="flex items-start gap-2 border-t border-border px-5 py-3 text-[13px] text-amber">
        <span className="break-words">{result.warning}</span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-2 border-t border-border px-5 py-3 text-[13px] text-green">
      <CheckCircle2 size={15} className="mt-px flex-none" />
      <span className="break-words">{t("integrations.entra.testOk")}</span>
    </p>
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

  // Tests the values currently in the form, the same fields Save sends, so it works before Save.
  const connection = useConnectionTest(() =>
    testAiProviderFn({
      data: {
        provider,
        apiKey: apiKey || undefined,
        model: model || undefined,
        azureEndpoint: azureEndpoint || undefined,
        azureDeployment: azureDeployment || undefined,
        openAiCompatibleBaseUrl: baseUrl || undefined,
      },
    }),
  );

  return (
    <SettingsSection title={t("integrations.ai.heading")} description={t("integrations.ai.description")} aside={<StatusBadge ok={initial.hasApiKey && initial.featuresEnabled} />}>
      <Card>
        <div className="flex flex-col gap-4 p-5">
          <Switch checked={enabled} onChange={setEnabled} label={t("integrations.ai.enable")} />
          <FormField label={t("integrations.ai.providerLabel")}>
            <NativeSelect value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
              <option value="anthropic">Anthropic</option>
              <option value="azure-foundry-anthropic">Claude on Azure AI Foundry</option>
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
                  {provider === "azure-foundry-anthropic" && <span className="font-normal text-text-3">{t("integrations.ai.foundryModelNote")}</span>}
                </span>
              }
            >
              <TextField value={model} onChange={(e) => setModel(e.target.value)} placeholder={provider === "anthropic" || provider === "azure-foundry-anthropic" ? "claude-sonnet-5" : t("integrations.ai.modelPlaceholderOther")} />
            </FormField>
          )}
          {provider === "azure-foundry-anthropic" && (
            <FormField label={t("integrations.ai.foundryEndpointLabel")}>
              <TextField value={azureEndpoint} onChange={(e) => setAzureEndpoint(e.target.value)} placeholder="https://<resource>.services.ai.azure.com/anthropic" />
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
        <SaveRow
          saving={saving}
          error={error}
          onSave={save}
          label={t("integrations.ai.save")}
          savingLabel={t("integrations.ai.savingEllipsis")}
          testButton={<TestConnectionButton testing={connection.testing} disabled={saving} onClick={connection.start} />}
        />
        {connection.result && (
          <div className="border-t border-border px-5 py-3">
            <ConnectionTestResultView result={connection.result} embedding={false} />
          </div>
        )}
      </Card>
    </SettingsSection>
  );
}

/** How often, and for how long, the test email's delivery state is polled after sending. */
const TEST_EMAIL_POLL_MS = 2000;
const TEST_EMAIL_TIMEOUT_MS = 45_000;

type TestEmailResult = { kind: "sent" } | { kind: "failed"; error: string | null } | { kind: "queued" } | { kind: "error"; message: string };

function MailSection({ initial, userEmail }: { initial: Integrations["mail"]; userEmail: string }) {
  const { t } = useTranslation("settings");
  const [driver, setDriver] = useState(initial.driver ?? "resend");
  const [from, setFrom] = useState(initial.from ?? "");
  const [apiKey, setApiKey] = useState("");
  const [smtpUrl, setSmtpUrl] = useState("");
  const { saving, error, run } = useSave(t("tabs.mail"));
  const [testTo, setTestTo] = useState(userEmail);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestEmailResult | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /** The test uses the SAVED settings, so it is only offered when the form has no unsaved edits. */
  const unsaved = driver !== (initial.driver ?? "resend") || from !== (initial.from ?? "") || apiKey !== "" || smtpUrl !== "";

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const { outboxId } = await sendTestEmailFn({ data: { to: testTo.trim() || undefined } });
      const deadline = Date.now() + TEST_EMAIL_TIMEOUT_MS;
      while (aliveRef.current) {
        const delivery = await getTestEmailStatusFn({ data: outboxId });
        if (!aliveRef.current) return;
        if (delivery?.state === "sent") {
          setTestResult({ kind: "sent" });
          return;
        }
        // Report the first failed attempt right away, not after the worker's retries are exhausted.
        if (delivery?.state === "failing" || delivery?.state === "failed") {
          setTestResult({ kind: "failed", error: delivery.error });
          return;
        }
        if (Date.now() >= deadline) {
          setTestResult({ kind: "queued" });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, TEST_EMAIL_POLL_MS));
      }
    } catch (err) {
      if (aliveRef.current) setTestResult({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (aliveRef.current) setTesting(false);
    }
  }

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
      <Card className="mt-4">
        <div className="flex flex-col gap-3 p-5">
          <p className="text-[14px] font-medium">{t("integrations.mail.test.heading")}</p>
          <p className="type-small text-text-3">{t("integrations.mail.test.hint")}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <TextField
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder={t("integrations.mail.test.recipientPlaceholder")}
              aria-label={t("integrations.mail.test.recipientPlaceholder")}
              className="sm:flex-1"
            />
            <Button variant="outline" onClick={sendTest} disabled={testing || unsaved || !testTo.trim()}>
              {testing ? t("integrations.mail.test.sendingEllipsis") : t("integrations.mail.test.send")}
            </Button>
          </div>
          {unsaved && <p className="text-[13px] text-text-3">{t("integrations.mail.test.unsavedHint")}</p>}
          {testResult && <TestEmailResultLine result={testResult} />}
        </div>
      </Card>
    </SettingsSection>
  );
}
