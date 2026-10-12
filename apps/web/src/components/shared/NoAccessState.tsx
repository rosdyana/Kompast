import { Link } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { EmptyState } from "@kompast/ui/EmptyState";
import { useTranslation } from "@kompast/i18n";

/**
 * Shown when a project/issue/page loader throws notFound(). Team-scoped
 * RLS makes "belongs to a team you're not in" indistinguishable from
 * "doesn't exist" at the database level, and the copy deliberately keeps
 * it that way — telling someone a hidden thing exists would leak exactly
 * what the RLS hides.
 */
export function NoAccessState() {
  const { t } = useTranslation("common");
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <EmptyState
        variant="plain"
        icon={<Lock size={18} />}
        title={t("noAccessTitle")}
        description={t("noAccessSubtext")}
        action={
          <Link to="/" className="inline-flex h-8 items-center rounded-[6px] bg-accent px-3 text-[14px] font-medium text-white hover:bg-accent-hover">
            {t("notFoundGoHome")}
          </Link>
        }
      />
    </div>
  );
}
