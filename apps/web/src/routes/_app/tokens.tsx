import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Check, Copy, KeyRound, Trash2 } from "lucide-react";
import { Button, IconButton } from "@kompast/ui/Button";
import { Badge } from "@kompast/ui/Badge";
import { Card } from "@kompast/ui/Card";
import { EmptyState } from "@kompast/ui/EmptyState";
import { FormField, TextField } from "@kompast/ui/Input";
import { PageContainer } from "@kompast/ui/PageContainer";
import { PageHeader } from "@kompast/ui/PageHeader";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import { listTokensFn, createTokenFn, revokeTokenFn, TOKEN_SCOPES } from "@/lib/server-fns/tokens";
import { ConfirmDialog } from "@/components/settings/ConfirmDialog";
import { usePageChrome } from "@/components/shell/WorkbenchContext";
import { cn } from "@/lib/cn";

export const Route = createFileRoute("/_app/tokens")({
  loader: () => listTokensFn(),
  component: TokensPage,
});

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };

function TokensPage() {
  const { t, i18n } = useTranslation("tokens");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const tokens = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);

  usePageChrome({ crumbs: [{ label: t("pageTitle"), icon: <KeyRound size={15} strokeWidth={1.75} className="text-text-3" /> }] }, [t]);

  function toggleScope(scope: string) {
    setScopes((s) => (s.includes(scope) ? s.filter((x) => x !== scope) : [...s, scope]));
  }

  async function createToken() {
    if (!name.trim() || scopes.length === 0) return;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await createTokenFn({ data: { name: name.trim(), scopes: scopes as (typeof TOKEN_SCOPES)[number][] } });
      setJustCreated(result.token);
      setCopied(false);
      setName("");
      setScopes([]);
      await router.invalidate();
    } catch (err) {
      setCreateError(t("createFailed", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setCreating(false);
    }
  }

  async function copy() {
    if (!justCreated) return;
    try {
      await navigator.clipboard.writeText(justCreated);
      setCopied(true);
    } catch {
      // clipboard blocked — the token stays visible for manual copy
    }
  }

  return (
    <PageContainer width="standard">
      <PageHeader title={t("pageTitle")} subtitle={t("pageSubtitle")} />

      {justCreated && (
        <div className="mb-6 rounded-[10px] border border-green/30 bg-green-soft p-4">
          <p className="mb-2 text-[14px] font-medium text-text">{t("newTokenCreated")}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-[6px] border border-border bg-surface px-3 py-2 font-mono text-[12.5px]">{justCreated}</code>
            <Button variant="outline" onClick={copy}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? t("copied") : t("copy")}
            </Button>
          </div>
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setJustCreated(null)}>
            {t("done")}
          </Button>
        </div>
      )}

      <Card className="mb-8">
        <div className="border-b border-border px-5 py-3">
          <h2 className="type-headline">{t("createNewTokenHeading")}</h2>
        </div>
        <form
          className="flex flex-col gap-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            createToken();
          }}
        >
          <FormField label={t("nameLabel")} htmlFor="token-name">
            <TextField id="token-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("tokenNamePlaceholder")} maxLength={80} />
          </FormField>
          <FormField label={t("scopesLabel")} hint={t("scopesHint")}>
            <div className="flex flex-wrap gap-2">
              {TOKEN_SCOPES.map((scope) => {
                const on = scopes.includes(scope);
                return (
                  <label
                    key={scope}
                    className={cn(
                      "inline-flex h-8 cursor-pointer items-center gap-2 rounded-[6px] border px-2.5 font-mono text-[12.5px] transition-colors",
                      on ? "border-accent bg-accent-soft text-accent-text" : "border-border-2 text-text-2 hover:bg-surface-2",
                    )}
                  >
                    <input type="checkbox" checked={on} onChange={() => toggleScope(scope)} />
                    {scope}
                  </label>
                );
              })}
            </div>
          </FormField>
          {createError && <p className="text-[13px] text-danger">{createError}</p>}
          <div>
            <Button type="submit" variant="primary" disabled={creating || !name.trim() || scopes.length === 0}>
              {t("createToken")}
            </Button>
          </div>
        </form>
      </Card>

      <h2 className="mb-2 type-headline">{t("activeTokensHeading")}</h2>
      {tokens.length === 0 ? (
        <EmptyState icon={<KeyRound size={18} />} title={t("noTokensYet")} />
      ) : (
        <Card className="overflow-hidden">
          {tokens.map((tok) => {
            const perms = Object.entries(tok.permissions ?? {}).flatMap(([r, actions]) => actions.map((a) => `${r}:${a}`));
            return (
              <div key={tok.id} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 hover:bg-surface-2">
                <span className="grid h-8 w-8 flex-none place-items-center rounded-[8px] bg-surface-3 text-text-2">
                  <KeyRound size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium">{tok.name || t("untitledToken")}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[12px] text-text-3">{tok.start}…</span>
                    {perms.length === 0 ? <Badge>{t("noScope")}</Badge> : perms.map((p) => <Badge key={p} className="font-mono">{p}</Badge>)}
                    {tok.expiresAt && <span className="text-[12px] text-text-3">{t("expiresOn", { date: new Date(tok.expiresAt).toLocaleDateString(intlLocale) }).replace(/^\s*·\s*/, "")}</span>}
                  </div>
                </div>
                <IconButton aria-label={t("revoke")} title={t("revoke")} onClick={() => setRevoking({ id: tok.id, name: tok.name || t("untitledToken") })} className="hover:text-danger">
                  <Trash2 size={15} />
                </IconButton>
              </div>
            );
          })}
        </Card>
      )}

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={t("revokeConfirmTitle", { name: revoking?.name ?? "" })}
        body={t("revokeConfirmBody")}
        confirmLabel={t("revoke")}
        cancelLabel={t("cancel")}
        onConfirm={async () => {
          if (!revoking) return;
          await revokeTokenFn({ data: revoking.id });
          toast.show({ title: t("revoked") });
          await router.invalidate();
        }}
      />
    </PageContainer>
  );
}
