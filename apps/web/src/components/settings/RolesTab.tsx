import { Card } from "@kompast/ui/Card";
import { useTranslation } from "@kompast/i18n";

/**
 * Static/informational only — deliberately NOT a configurable
 * permission-rule engine. The current role model is four separate
 * vocabularies enforced in code (packages/core/src/permissions.ts,
 * packages/core/src/settings.ts's requireSystemAdmin), not data; this page
 * documents what's actually true today rather than a speculative matrix.
 */
const ROLE_KEYS = ["superAdmin", "workspaceOwner", "teamAdmin", "teamMember", "projectRole"] as const;

export function RolesTab() {
  const { t } = useTranslation("settings");
  return (
    <div>
      <p className="mb-6 text-sm text-text-2">{t("roles.intro")}</p>
      <Card className="overflow-hidden">
        {ROLE_KEYS.map((key) => (
          <div key={key} className="border-b border-border px-4 py-3 last:border-b-0">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[13px] font-semibold">{t(`roles.${key}.name`)}</span>
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] text-text-3">{t(`roles.${key}.scope`)}</span>
            </div>
            <p className="text-[12px] leading-relaxed text-text-2">{t(`roles.${key}.desc`)}</p>
          </div>
        ))}
      </Card>
    </div>
  );
}
