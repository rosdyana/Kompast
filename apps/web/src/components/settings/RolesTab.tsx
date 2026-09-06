import { Card } from "@kompast/ui/Card";
import { Badge } from "@kompast/ui/Badge";
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
      <p className="mb-6 type-body text-text-2">{t("roles.intro")}</p>
      <Card className="overflow-hidden">
        {ROLE_KEYS.map((key) => (
          <div key={key} className="border-b border-border px-4 py-3 last:border-b-0">
            <div className="mb-1 flex items-center gap-2">
              <span className="type-body font-semibold">{t(`roles.${key}.name`)}</span>
              <Badge tone="neutral">{t(`roles.${key}.scope`)}</Badge>
            </div>
            <p className="type-body leading-relaxed text-text-2">{t(`roles.${key}.desc`)}</p>
          </div>
        ))}
      </Card>
    </div>
  );
}
