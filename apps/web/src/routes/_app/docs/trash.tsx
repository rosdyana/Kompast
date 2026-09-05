import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Button } from "@kompast/ui/Button";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import { listTrashFn, restorePageFn, permanentlyDeletePageFn } from "@/lib/server-fns/pages";

export const Route = createFileRoute("/_app/docs/trash")({
  loader: () => listTrashFn(),
  component: TrashPage,
});

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };

function TrashPage() {
  const { t, i18n } = useTranslation("docs");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const pages = Route.useLoaderData();
  const router = useRouter();

  async function restore(pageId: string) {
    await restorePageFn({ data: pageId });
    await router.invalidate();
  }

  async function deleteForever(pageId: string, title: string) {
    if (!window.confirm(t("trash.deleteConfirm", { title: title || t("untitled") }))) return;
    await permanentlyDeletePageFn({ data: pageId });
    await router.invalidate();
  }

  return (
    <div className="mx-auto max-w-[820px] px-8 pb-16 pt-9">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link to="/docs" className="mb-1 inline-block text-xs text-text-3 hover:text-text-2">
            ← {t("docsBrand")}
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{t("trash.trashHeading")}</h1>
        </div>
      </div>

      {pages.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-10 text-center text-sm text-text-3">
          {t("trash.trashEmpty")}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {pages.map((page) => (
            <div key={page.id} className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5 text-[13px]">
              <span>{page.icon || "▤"}</span>
              <span className="min-w-0 flex-1 truncate">{page.title || t("untitled")}</span>
              <span className="flex-none text-[11px] text-text-3">
                {page.archivedAt ? t("trash.archivedOn", { date: new Date(page.archivedAt).toLocaleDateString(intlLocale) }) : ""}
              </span>
              <Button variant="outline" className="text-[11.5px]" onClick={() => restore(page.id)}>
                {t("restore")}
              </Button>
              <button
                onClick={() => deleteForever(page.id, page.title)}
                className="rounded-md px-2 py-1 text-[11.5px] text-text-3 hover:bg-danger-soft hover:text-danger"
              >
                {t("trash.deletePermanently")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
