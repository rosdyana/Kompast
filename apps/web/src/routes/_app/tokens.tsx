import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { Card } from "@kompast/ui/Card";
import { PageContainer } from "@kompast/ui/PageContainer";
import { PageHeader } from "@kompast/ui/PageHeader";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import { listTokensFn, createTokenFn, revokeTokenFn, TOKEN_SCOPES } from "@/lib/server-fns/tokens";

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
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<string | null>(null);

  function toggleScope(scope: string) {
    setScopes((s) => (s.includes(scope) ? s.filter((x) => x !== scope) : [...s, scope]));
  }

  async function createToken() {
    if (!name.trim() || scopes.length === 0) return;
    setCreating(true);
    try {
      const result = await createTokenFn({ data: { name: name.trim(), scopes: scopes as (typeof TOKEN_SCOPES)[number][] } });
      setJustCreated(result.token);
      setName("");
      setScopes([]);
      await router.invalidate();
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    await revokeTokenFn({ data: id });
    await router.invalidate();
  }

  return (
    <PageContainer width="standard">
      <PageHeader title={t("pageTitle")} subtitle={t("pageSubtitle")} />

      {justCreated && (
        <Card className="mb-6 p-4 text-[12.5px]">
          <p className="mb-2 font-semibold text-text-2">{t("newTokenCreated")}</p>
          <code className="block break-all rounded-[7px] bg-surface-2 p-2.5 text-[12px]">{justCreated}</code>
          <Button variant="outline" className="mt-2" onClick={() => setJustCreated(null)}>
            {t("done")}
          </Button>
        </Card>
      )}

      <Card className="mb-8 p-4">
        <h2 className="mb-3 type-headline">{t("createNewTokenHeading")}</h2>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("tokenNamePlaceholder")}
          className="mb-3 w-full rounded-[7px] border border-border bg-surface px-2.5 py-1.5 text-[12.5px] outline-none focus:border-border-2"
        />
        <div className="mb-3 flex flex-wrap gap-2">
          {TOKEN_SCOPES.map((scope) => (
            <label
              key={scope}
              className="flex items-center gap-1.5 rounded-[7px] border border-border px-2 py-1 text-[11.5px] has-[:checked]:border-accent has-[:checked]:text-accent"
            >
              <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} />
              {scope}
            </label>
          ))}
        </div>
        <Button variant="primary" onClick={createToken} disabled={creating || !name.trim() || scopes.length === 0}>
          {t("createToken")}
        </Button>
      </Card>

      <h2 className="mb-3 type-headline">{t("activeTokensHeading")}</h2>
      {tokens.length === 0 ? (
        <p className="type-body text-text-3">{t("noTokensYet")}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {tokens.map((tok) => (
            <div key={tok.id} className="flex items-center gap-2.5 rounded-[9px] border border-border bg-surface px-3 py-2.5 text-[12.5px]">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{tok.name || t("untitledToken")}</p>
                <p className="truncate type-label text-text-3">
                  {tok.start}… · {Object.entries(tok.permissions ?? {}).flatMap(([r, actions]) => actions.map((a) => `${r}:${a}`)).join(", ") || t("noScope")}
                  {tok.expiresAt && t("expiresOn", { date: new Date(tok.expiresAt).toLocaleDateString(intlLocale) })}
                </p>
              </div>
              <button onClick={() => revoke(tok.id)} className="flex-none rounded-[7px] px-2 py-1 text-[11.5px] text-text-3 hover:bg-danger-soft hover:text-danger">
                {t("revoke")}
              </button>
            </div>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
