import { Button } from "@kompast/ui/Button";
import { useTranslation } from "@kompast/i18n";
import type { NotionTargetChoice, SelectionCounts } from "@/lib/notion-migration-tree";
import { targetLabel, type TeamOption } from "./shared";

interface ReviewStepProps {
  counts: SelectionCounts;
  roots: { notionId: string; title: string; target: NotionTargetChoice }[];
  teams: TeamOption[];
  busy: boolean;
  onBack: () => void;
  onStart: () => void;
}

const KEPT = ["hierarchy", "formatting", "colors", "tables", "files", "links", "people"] as const;
const LOST = ["columns", "comments", "history", "views"] as const;

/**
 * Step 4: what the run will touch, and what survives the trip. Nothing is
 * copied until Start. The counts come from the picked tree, so the sub-pages
 * under a checked page are included.
 */
export function ReviewStep({ counts, roots, teams, busy, onBack, onStart }: ReviewStepProps) {
  const { t } = useTranslation("docs");
  const tLabel = (key: "notionImport.workspace" | "notionImport.private" | "notionImport.team") => t(key);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="type-small text-text-2">{t("notionMigration.review.description")}</p>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t("notionMigration.review.roots")} value={counts.roots} />
        <Stat label={t("notionMigration.review.pages")} value={counts.pages} />
        <Stat label={t("notionMigration.review.databases")} value={counts.databases} />
        <Stat label={t("notionMigration.review.rows")} value={counts.rows} />
      </dl>

      <section className="rounded-[8px] border border-border bg-surface-2 p-3.5">
        <ul className="flex flex-col gap-1.5 text-[13.5px] text-text">
          {roots.map((root) => (
            <li key={root.notionId} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate">{root.title || "—"}</span>
              <span className="flex-none text-[12.5px] text-text-3">{targetLabel(root.target, teams, tLabel)}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <section>
          <h4 className="mb-2 text-[13px] font-medium text-text-2">{t("notionMigration.review.keptHeading")}</h4>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13.5px] text-text">
            {KEPT.map((key) => (
              <li key={key}>{t(`notionMigration.review.kept.${key}`)}</li>
            ))}
          </ul>
        </section>
        <section>
          <h4 className="mb-2 text-[13px] font-medium text-text-2">{t("notionMigration.review.lostHeading")}</h4>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13.5px] text-text-2">
            {LOST.map((key) => (
              <li key={key}>{t(`notionMigration.review.lost.${key}`)}</li>
            ))}
          </ul>
        </section>
      </div>

      <div className="flex justify-between gap-2 pt-1">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          {t("notionMigration.back")}
        </Button>
        <Button variant="primary" onClick={onStart} disabled={busy || roots.length === 0}>
          {busy ? t("notionMigration.review.starting") : t("notionMigration.review.start")}
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[8px] border border-border bg-surface-2 p-3">
      <dt className="text-[12.5px] text-text-3">{label}</dt>
      <dd className="mt-1 text-[18px] font-medium text-text">{value}</dd>
    </div>
  );
}
