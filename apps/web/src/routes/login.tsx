import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Avatar } from "@kompast/ui/Avatar";
import { Button } from "@kompast/ui/Button";
import { Badge } from "@kompast/ui/Badge";
import { TextField } from "@kompast/ui/Input";
import { useTranslation } from "@kompast/i18n";
import { authClient, signInWithMicrosoft, signInAsDevAdmin } from "@/lib/auth-client";
import { setLocaleFn } from "@/lib/server-fns/locale";
import type { DemoPersona } from "@/lib/demo";
import { getDevLoginStatusFn } from "@/lib/server-fns/dev-login";
import { AuthLayout, MicrosoftGlyph } from "@/components/auth/AuthLayout";

export const Route = createFileRoute("/login")({
  loader: () => getDevLoginStatusFn(),
  component: LoginPage,
});

function LoginPage() {
  const { t } = useTranslation("auth");
  const { enabled: devLoginEnabled, microsoftConfigured, demo } = Route.useLoaderData();
  const router = useRouter();
  const [devPassword, setDevPassword] = useState("");
  const [devLoginError, setDevLoginError] = useState<string | null>(null);
  const [devLoginBusy, setDevLoginBusy] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  async function submitDevLogin() {
    if (!devPassword.trim()) return;
    setDevLoginBusy(true);
    setDevLoginError(null);
    try {
      const { error } = await signInAsDevAdmin(devPassword);
      if (error) {
        setDevLoginError(t("devLoginError"));
        return;
      }
      await router.navigate({ to: "/" });
    } finally {
      setDevLoginBusy(false);
    }
  }

  return (
    <AuthLayout>
      <h2 className="type-title">{t("signInHeading")}</h2>
      <p className="mt-2 type-body text-text-2">{t("signInSubtext")}</p>
      {(microsoftConfigured || !demo.enabled) && (
        <Button
          variant="dark"
          size="lg"
          className="mt-7 w-full"
          disabled={redirecting}
          onClick={() => {
            setRedirecting(true);
            signInWithMicrosoft().catch(() => setRedirecting(false));
          }}
        >
          <MicrosoftGlyph />
          {t("continueWithMicrosoft")}
        </Button>
      )}

      {demo.enabled && demo.personas.length > 0 && <DemoPersonaPicker personas={demo.personas} />}

      {devLoginEnabled && (
        <div className="mt-6 rounded-[10px] border border-dashed border-amber/40 bg-amber-soft/50 p-4">
          <Badge tone="amber">{t("devLoginBadge")}</Badge>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitDevLogin();
            }}
          >
            <TextField
              type="password"
              value={devPassword}
              onChange={(e) => setDevPassword(e.target.value)}
              placeholder={t("devLoginPasswordPlaceholder")}
              aria-label={t("devLoginPasswordPlaceholder")}
              aria-invalid={!!devLoginError}
              className="min-w-0 flex-1"
            />
            <Button type="submit" variant="outline" disabled={devLoginBusy || !devPassword.trim()}>
              {t("devLoginButton")}
            </Button>
          </form>
          {devLoginError && <p className="mt-2 text-[13px] text-danger">{devLoginError}</p>}
        </div>
      )}
    </AuthLayout>
  );
}

const ACCESS_CODE_KEY = "kompast-demo-access-code";

/**
 * Stakeholder-demo sign-in (lib/demo.ts): one access code, then one click
 * per persona. Every demo account's password is the access code, so this
 * is a plain email+password sign-in — nothing about the code ever comes
 * from the server. Kept in sessionStorage so a presenter switching personas
 * mid-demo (log out → pick another) doesn't retype it.
 */
function DemoPersonaPicker({ personas }: { personas: DemoPersona[] }) {
  const { t } = useTranslation("auth");
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The cards are server-rendered; until React hydrates they have no click
  // handler, so an early click (slow connection, eager presenter) would do
  // nothing at all. Disabled-until-hydrated makes that visible instead.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
    try {
      setCode(window.sessionStorage.getItem(ACCESS_CODE_KEY) ?? "");
    } catch {
      /* storage blocked — just retype */
    }
  }, []);

  async function signInAs(persona: DemoPersona) {
    if (!code.trim()) {
      setError(t("demoCodeRequired"));
      return;
    }
    setBusyEmail(persona.email);
    setError(null);
    try {
      const { error: signInError } = await authClient.signIn.email({ email: persona.email, password: code.trim() });
      if (signInError) {
        // A 429 isn't a wrong code — say so, or a presenter retypes a correct code mid-demo.
        setError(signInError.status === 429 ? t("demoRateLimited") : t("demoCodeWrong"));
        return;
      }
      try {
        window.sessionStorage.setItem(ACCESS_CODE_KEY, code.trim());
      } catch {
        /* not persisted */
      }
      // Each persona demos in their team's working language.
      await setLocaleFn({ data: { locale: persona.locale } });
      await router.navigate({ to: "/" });
      await router.invalidate();
    } finally {
      setBusyEmail(null);
    }
  }

  return (
    <div className="mt-6">
      <div className="flex items-center gap-2">
        <Badge tone="accent">{t("demoBadge")}</Badge>
        <span className="type-small text-text-2">{t("demoSubtext")}</span>
      </div>
      <TextField
        type="password"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder={t("demoCodePlaceholder")}
        aria-label={t("demoCodePlaceholder")}
        aria-invalid={!!error}
        className="mt-3 w-full"
      />
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
      <div className="mt-3 flex flex-col gap-1.5">
        {personas.map((p) => (
          <button
            key={p.email}
            type="button"
            onClick={() => signInAs(p)}
            disabled={!hydrated || busyEmail !== null}
            className="flex items-center gap-3 rounded-[8px] border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:border-border-2 hover:bg-surface-2 disabled:opacity-60"
          >
            <Avatar name={p.name} size={30} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium text-text">{p.name}</span>
              <span className="block truncate text-[12.5px] text-text-3">
                {t(`demoRole.${p.role}`)}
                {p.team ? ` · ${p.team}` : ""}
              </span>
            </span>
            <span className="flex-none text-[12px] text-text-3">{busyEmail === p.email ? t("demoSigningIn") : p.locale === "zh-Hant" ? "繁中" : "EN"}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

