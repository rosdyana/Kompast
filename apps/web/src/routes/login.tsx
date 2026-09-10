import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { Badge } from "@kompast/ui/Badge";
import { useTranslation } from "@kompast/i18n";
import { signInWithMicrosoft, signInAsDevAdmin } from "@/lib/auth-client";
import { getDevLoginStatusFn } from "@/lib/server-fns/dev-login";

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
    <div className="grid min-h-screen grid-cols-[1.05fr_0.95fr] bg-bg">
      <div className="relative flex flex-col justify-between overflow-hidden bg-indigo px-15 py-14 text-white">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(circle at 78% 22%, rgba(255,255,255,.1), transparent 42%), linear-gradient(rgba(255,255,255,.06) 1px,transparent 1px), linear-gradient(90deg,rgba(255,255,255,.06) 1px,transparent 1px)",
            backgroundSize: "auto, 44px 44px, 44px 44px",
          }}
        />
        <div className="relative flex items-center gap-2.5">
          <div className="grid h-[30px] w-[30px] place-items-center rounded-[9px] bg-accent">
            <div className="h-2 w-2 rotate-45 rounded-sm bg-white" />
          </div>
          <span className="type-headline">Kompast</span>
        </div>
        <div className="relative max-w-[430px]">
          <p className="mb-4 type-label-overline text-white/55">{t("tagline")}</p>
          <h1 className="type-display">{t("heroHeadline")}</h1>
          <p className="mt-5 text-[15px] leading-relaxed text-white/72">{t("heroSubtext")}</p>
        </div>
        <div className="relative flex gap-7 text-[12.5px] text-white/60">
          <span>{t("featureWorkspaceTeam")}</span>
          <span>{t("featureGranularRoles")}</span>
          <span>{t("featureSsoMicrosoft")}</span>
        </div>
      </div>

      <div className="flex items-center justify-center p-12">
        <div className="w-full max-w-[352px]">
          <h2 className="mb-2 type-title">{t("signInHeading")}</h2>
          <p className="mb-7 type-body leading-relaxed text-text-2">{t("signInSubtext")}</p>
          <Button variant="dark" className="w-full py-3.5" onClick={() => signInWithMicrosoft()}>
            <MicrosoftGlyph />
            {t("continueWithMicrosoft")}
          </Button>
          <div className="my-[22px] flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-[11.5px] text-text-3">{t("or")}</span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <Button variant="outline" className="w-full py-3" onClick={() => signInWithMicrosoft()}>
            {t("signInWithEmailLink")}
          </Button>
          {devLoginEnabled && (
            <div className="mt-[22px] rounded-[9px] border border-dashed border-danger-soft px-3.5 py-3">
              <Badge tone="amber">{t("devLoginBadge")}</Badge>
              <div className="mt-2.5 flex gap-1.5">
                <input
                  type="password"
                  value={devPassword}
                  onChange={(e) => setDevPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitDevLogin()}
                  placeholder={t("devLoginPasswordPlaceholder")}
                  className="min-w-0 flex-1 rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none"
                />
                <Button variant="outline" onClick={submitDevLogin} disabled={devLoginBusy || !devPassword.trim()}>
                  {t("devLoginButton")}
                </Button>
              </div>
              {devLoginError && <p className="mt-2 type-body text-danger">{devLoginError}</p>}
            </div>
          )}
          <p className="mt-7 type-body leading-relaxed text-text-3">
            {t("agreementPart1")}
            <a href="#">{t("termsOfService")}</a>
            {t("agreementPart2")}
            <a href="#">{t("privacyPolicy")}</a>
            {t("agreementPart3")}
          </p>
          <div className="mt-[34px] flex items-start gap-2.5 rounded-[9px] border border-dashed border-border-2 bg-surface-2 p-3.5">
            <div className="mt-1.5 h-1.5 w-1.5 animate-[kp-blink_2.2s_infinite] rounded-full bg-green" />
            <p className="type-body leading-relaxed text-text-2">
              {t("tenantDetectedPart1")}
              <strong className="text-text">asus.com</strong>
              {t("tenantDetectedPart2")}
              <strong className="text-text">Cloud Platform</strong>
              {t("tenantDetectedPart3")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function MicrosoftGlyph() {
  return (
    <span className="grid grid-cols-2 grid-rows-2 gap-0.5" style={{ width: 16, height: 16 }}>
      <i className="bg-[#f25022]" />
      <i className="bg-[#7fba00]" />
      <i className="bg-[#00a4ef]" />
      <i className="bg-[#ffb900]" />
    </span>
  );
}
