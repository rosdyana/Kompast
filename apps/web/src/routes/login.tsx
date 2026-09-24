import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { Badge } from "@kompast/ui/Badge";
import { TextField } from "@kompast/ui/Input";
import { useTranslation } from "@kompast/i18n";
import { signInWithMicrosoft, signInAsDevAdmin } from "@/lib/auth-client";
import { getDevLoginStatusFn } from "@/lib/server-fns/dev-login";
import { AuthLayout, MicrosoftGlyph } from "@/components/auth/AuthLayout";

export const Route = createFileRoute("/login")({
  loader: () => getDevLoginStatusFn(),
  component: LoginPage,
});

function LoginPage() {
  const { t } = useTranslation("auth");
  const { enabled: devLoginEnabled } = Route.useLoaderData();
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
