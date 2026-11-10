import { Dialog } from "@kompast/ui/Dialog";
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

export function RolesHelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation("settings");
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={t("tabs.roles")} description={t("roles.intro")} closeLabel={t("members.rolesHelpClose")}>
      <div>
        {ROLE_KEYS.map((key) => (
          <div key={key} className="flex flex-col gap-1 border-b border-border py-3.5 first:pt-0 last:border-b-0 last:pb-0 sm:flex-row sm:gap-6">
            <div className="flex flex-none items-start gap-2 sm:w-[240px] sm:flex-col sm:gap-1.5">
              <span className="text-[14px] font-medium">{t(`roles.${key}.name`)}</span>
              <Badge>{t(`roles.${key}.scope`)}</Badge>
            </div>
            <p className="type-body text-text-2">{t(`roles.${key}.desc`)}</p>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
