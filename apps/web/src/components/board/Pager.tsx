import { ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton } from "@kompast/ui/Button";
import { useTranslation } from "@kompast/i18n";
import { cn } from "@/lib/cn";

/** Previous / next controls with an "11–20 of 134" range. Renders nothing when everything fits on one page. */
export function Pager({
  page,
  pageSize,
  total,
  onPage,
  disabled,
  className,
}: {
  /** Zero-based. */
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("board");
  if (total <= pageSize) return null;
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <nav className={cn("flex items-center gap-2 type-small text-text-2", className)} aria-label={t("pager.label")}>
      <span className="tabular-nums">{t("pager.range", { from, to, total })}</span>
      <IconButton onClick={() => onPage(page - 1)} disabled={disabled || page <= 0} aria-label={t("pager.previous")}>
        <ChevronLeft size={15} />
      </IconButton>
      <IconButton onClick={() => onPage(page + 1)} disabled={disabled || page >= lastPage} aria-label={t("pager.next")}>
        <ChevronRight size={15} />
      </IconButton>
    </nav>
  );
}
