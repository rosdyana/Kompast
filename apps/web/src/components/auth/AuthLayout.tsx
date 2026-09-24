import type { ReactNode } from "react";
import { FileText, KanbanSquare, Lock } from "lucide-react";
import { useTranslation } from "@kompast/i18n";
import { CompassMark } from "@/components/shell/ProjectIcon";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";

/**
 * Signed-out shell (login, setup, invite): a calm navy brand panel on the
 * left, the task card on the right. Stacks on narrow screens, where the
 * brand panel shrinks to a header strip.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation("auth");
  return (
    <div className="grid min-h-screen grid-cols-1 bg-bg lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <aside className="relative flex flex-col justify-between gap-10 overflow-hidden bg-indigo px-6 py-6 text-white sm:px-10 lg:px-14 lg:py-12">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            backgroundImage: "linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px), linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px)",
            backgroundSize: "40px 40px",
            maskImage: "radial-gradient(ellipse at 70% 30%, black 20%, transparent 75%)",
          }}
        />
        <div className="relative flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-white/10">
            <CompassMark size={22} />
          </span>
          <span className="text-[16px] font-semibold tracking-tight">Kompast</span>
        </div>
        <div className="relative hidden max-w-[440px] lg:block">
          <h1 className="text-[34px] font-bold leading-[1.15] tracking-[-0.02em]">{t("heroHeadline")}</h1>
          <p className="mt-4 text-[16px] leading-relaxed text-white/75">{t("heroSubtext")}</p>
          <ul className="mt-8 flex flex-col gap-3 text-[14px] text-white/80">
            <li className="flex items-center gap-3">
              <span className="grid h-7 w-7 place-items-center rounded-[7px] bg-white/10">
                <FileText size={15} />
              </span>
              {t("tagline")}
            </li>
            <li className="flex items-center gap-3">
              <span className="grid h-7 w-7 place-items-center rounded-[7px] bg-white/10">
                <KanbanSquare size={15} />
              </span>
              {t("featureWorkspaceTeam")} · {t("featureGranularRoles")}
            </li>
            <li className="flex items-center gap-3">
              <span className="grid h-7 w-7 place-items-center rounded-[7px] bg-white/10">
                <Lock size={15} />
              </span>
              {t("featureSsoMicrosoft")}
            </li>
          </ul>
        </div>
        <p className="relative hidden text-[12.5px] text-white/50 lg:block">© Kompast</p>
      </aside>

      <main className="relative flex items-start justify-center px-5 py-10 sm:items-center sm:px-10">
        <div className="absolute right-4 top-4">
          <LocaleSwitcher />
        </div>
        <div className="w-full max-w-[420px] pt-8 sm:pt-0">{children}</div>
      </main>
    </div>
  );
}

export function MicrosoftGlyph() {
  return (
    <span aria-hidden className="grid flex-none grid-cols-2 grid-rows-2 gap-[2px]" style={{ width: 16, height: 16 }}>
      <i className="bg-[#f25022]" />
      <i className="bg-[#7fba00]" />
      <i className="bg-[#00a4ef]" />
      <i className="bg-[#ffb900]" />
    </span>
  );
}
