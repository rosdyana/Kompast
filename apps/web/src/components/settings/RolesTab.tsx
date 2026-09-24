import { Card } from "@kompast/ui/Card";
import { Badge } from "@kompast/ui/Badge";
import { useTranslation } from "@kompast/i18n";
import { SettingsSection } from "./SettingsSection";

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
    <SettingsSection title={t("tabs.roles")} description={t("roles.intro")}>
      <Card className="overflow-hidden">
        {ROLE_KEYS.map((key) => (
          <div key={key} className="flex flex-col gap-1 border-b border-border px-4 py-3.5 last:border-b-0 sm:flex-row sm:gap-6">
            <div className="flex flex-none items-start gap-2 sm:w-[240px] sm:flex-col sm:gap-1.5">
              <span className="text-[14px] font-medium">{t(`roles.${key}.name`)}</span>
              <Badge>{t(`roles.${key}.scope`)}</Badge>
            </div>
            <p className="type-body text-text-2">{t(`roles.${key}.desc`)}</p>
          </div>
        ))}
      </Card>
    </SettingsSection>
  );
}
