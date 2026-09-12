import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Lock, ShieldCheck, Users } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { Badge } from "@kompast/ui/Badge";
import { Card } from "@kompast/ui/Card";
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
    <div className="grid min-h-screen grid-cols-1 bg-bg lg:grid-cols-[1.05fr_0.95fr]">
      <div className="relative flex flex-col justify-between overflow-hidden bg-[#1b3a6b] px-6 py-10 text-white sm:px-10 sm:py-12 lg:px-15 lg:py-14">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(circle at 78% 22%, rgba(255,255,255,.1), transparent 42%), linear-gradient(rgba(255,255,255,.06) 1px,transparent 1px), linear-gradient(90deg,rgba(255,255,255,.06) 1px,transparent 1px)",
            backgroundSize: "auto, 44px 44px, 44px 44px",
          }}
        />
        <div
          className="pointer-events-none absolute -right-36 top-1/2 hidden h-[520px] w-[520px] -translate-y-1/2 rotate-45 border-2 border-white/[0.14] lg:block"
          aria-hidden="true"
        >
          <div className="absolute inset-14 border-2 border-white/[0.11]" />
        </div>
        <div className="relative flex items-center gap-2.5">
          <img src="/favicon.png" alt="" className="h-[30px] w-[30px] object-contain" />
          <span className="type-headline">Kompast</span>
        </div>
        <div className="relative max-w-[430px]">
          <p className="mb-4 type-label-overline text-white/55">{t("tagline")}</p>
          <h1 className="type-display">{t("heroHeadline")}</h1>
          <p className="mt-5 text-[15px] leading-relaxed text-white/72">{t("heroSubtext")}</p>
        </div>
        <div className="relative flex flex-wrap gap-x-6 gap-y-2.5 text-[12.5px] text-white/60">
          <span className="inline-flex items-center gap-2">
            <Users size={14} strokeWidth={1.75} className="text-white/45" />
            {t("featureWorkspaceTeam")}
          </span>
          <span className="inline-flex items-center gap-2">
            <ShieldCheck size={14} strokeWidth={1.75} className="text-white/45" />
            {t("featureGranularRoles")}
          </span>
          <span className="inline-flex items-center gap-2">
            <Lock size={14} strokeWidth={1.75} className="text-white/45" />
            {t("featureSsoMicrosoft")}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-center px-6 py-12 sm:px-12">
        <Card className="w-full max-w-[420px] p-8 sm:p-9">
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
                  className="kp-field min-w-0 flex-1"
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
            <a href="#" className="text-text-2 underline underline-offset-2 hover:text-text">
              {t("termsOfService")}
            </a>
            {t("agreementPart2")}
            <a href="#" className="text-text-2 underline underline-offset-2 hover:text-text">
              {t("privacyPolicy")}
            </a>
            {t("agreementPart3")}
          </p>
        </Card>
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
