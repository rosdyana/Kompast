import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { Dialog } from "@kompast/ui/Dialog";
import { EmptyState } from "@kompast/ui/EmptyState";
import { PageContainer } from "@kompast/ui/PageContainer";
import { PageHeader } from "@kompast/ui/PageHeader";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import { listTrashFn, restorePageFn, permanentlyDeletePageFn } from "@/lib/server-fns/pages";
import { PageIcon } from "@/components/docs/DocsTree";
import { relativeTime } from "@/components/docs/relative-time";
import { usePageChrome } from "@/components/shell/WorkbenchContext";

export const Route = createFileRoute("/_app/docs/trash")({
  loader: () => listTrashFn(),
  component: TrashPage,
});

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };

function TrashPage() {
  const { t, i18n } = useTranslation(["docs", "common"]);
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const pages = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const [confirm, setConfirm] = useState<{ id: string; title: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  usePageChrome(
    {
      crumbs: [
        { label: t("docsBrand"), link: { to: "/docs" } },
        { label: t("trash.trashHeading"), icon: <Trash2 size={15} strokeWidth={1.75} className="text-text-3" /> },
      ],
    },
    [i18n.language],
  );

  async function restore(pageId: string) {
    setBusyId(pageId);
    try {
      await restorePageFn({ data: pageId });
      toast.show({ title: t("trash.restored") });
      await router.invalidate();
    } finally {
      setBusyId(null);
    }
  }

  async function deleteForever() {
    if (!confirm) return;
    setBusyId(confirm.id);
    try {
      await permanentlyDeletePageFn({ data: confirm.id });
      toast.show({ title: t("trash.deleted") });
      setConfirm(null);
      await router.invalidate();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageContainer width="wide">
      <PageHeader title={t("trash.trashHeading")} subtitle={t("trash.trashSubtitle")} />

      {pages.length === 0 ? (
        <EmptyState icon={<Trash2 size={18} />} title={t("trash.trashEmpty")} description={t("trash.trashEmptyHint")} />
      ) : (
        <div className="overflow-hidden rounded-[8px] border border-border">
          <div className="hidden grid-cols-[minmax(0,1fr)_130px_auto] gap-4 border-b border-border bg-surface-2 px-4 py-2 text-[12.5px] font-medium text-text-3 sm:grid">
            <span>{t("index.colTitle")}</span>
            <span>{t("trash.colDeleted")}</span>
            <span className="w-[210px]" />
          </div>
          {pages.map((page) => (
            <div
              key={page.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-border bg-surface px-4 py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_130px_auto]"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <PageIcon icon={page.icon} size={17} />
                <span className="truncate text-[14.5px] text-text">{page.title || <span className="text-text-3">{t("untitled")}</span>}</span>
              </span>
              <span className="hidden text-[13px] tabular-nums text-text-3 sm:block" title={page.archivedAt ? new Date(page.archivedAt).toLocaleString(intlLocale) : undefined}>
                {page.archivedAt ? relativeTime(new Date(page.archivedAt), intlLocale) : ""}
              </span>
              <span className="flex w-auto items-center justify-end gap-1 sm:w-[210px]">
                <Button variant="ghost" size="sm" onClick={() => restore(page.id)} disabled={busyId !== null}>
                  <RotateCcw size={14} />
                  {t("restore")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirm({ id: page.id, title: page.title })}
                  disabled={busyId !== null}
                  className="text-danger hover:bg-danger-soft hover:text-danger"
                >
                  {t("trash.deletePermanently")}
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        size="sm"
        title={t("trash.deleteTitle")}
        closeLabel={t("common:close")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t("common:cancel")}
            </Button>
            <Button variant="danger" onClick={deleteForever} disabled={busyId !== null}>
              {t("trash.deletePermanently")}
            </Button>
          </>
        }
      >
        <p className="text-[14px] text-text-2">{t("trash.deleteConfirm", { title: confirm?.title || t("untitled") })}</p>
      </Dialog>
    </PageContainer>
  );
}
