import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { FileText, LayoutTemplate, Plus } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { PageContainer } from "@kompast/ui/PageContainer";
import { PageHeader } from "@kompast/ui/PageHeader";
import { EmptyState } from "@kompast/ui/EmptyState";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import { listPageTreeFn, listTemplatePagesFn, createPageFromTemplateFn } from "@/lib/server-fns/pages";
import { PageIcon } from "@/components/docs/DocsTree";
import { relativeTime } from "@/components/docs/relative-time";
import { ProjectIcon } from "@/components/shell/ProjectIcon";
import { usePageChrome, useWorkbench } from "@/components/shell/WorkbenchContext";

export const Route = createFileRoute("/_app/docs/")({
  loader: async () => {
    const [pageTree, templates] = await Promise.all([listPageTreeFn(), listTemplatePagesFn()]);
    return { ...pageTree, templates };
  },
  component: DocsIndexPage,
});

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };

function DocsIndexPage() {
  const { t, i18n } = useTranslation("docs");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const data = Route.useLoaderData();
  const navigate = useNavigate();
  const { createPage } = useWorkbench();
  const [usingTemplateId, setUsingTemplateId] = useState<string | null>(null);

  usePageChrome({ crumbs: [{ label: t("index.title"), icon: <FileText size={15} strokeWidth={1.75} className="text-text-3" /> }] }, [i18n.language]);

  async function useTemplate(templatePageId: string) {
    setUsingTemplateId(templatePageId);
    try {
      const page = await createPageFromTemplateFn({ data: { templatePageId } });
      await navigate({ to: "/docs/$pageId", params: { pageId: page.id } });
    } finally {
      setUsingTemplateId(null);
    }
  }

  const byId = new Map(data.pages.map((p) => [p.id, p]));
  const locationOf = (parentId: string | null) => {
    const parts: string[] = [];
    let cursor = parentId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = byId.get(cursor);
      if (!parent) break;
      parts.unshift(parent.title || t("untitled"));
      cursor = parent.parentPageId;
    }
    return parts.length ? parts.join(" / ") : t("index.rootLocation");
  };
  const pages = [...data.pages].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return (
    <PageContainer width="dense">
      <PageHeader
        title={t("index.title")}
        subtitle={t("index.subtitle")}
        actions={
          <Button variant="primary" onClick={() => createPage()}>
            <Plus size={15} strokeWidth={2.25} />
            {t("index.newPageButton")}
          </Button>
        }
      />

      {data.templates.length > 0 && (
        <section className="mb-9">
          <h2 className="mb-3 type-headline">{t("index.templatesHeading")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.templates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => useTemplate(tpl.id)}
                disabled={usingTemplateId !== null}
                className="group flex flex-col gap-3 rounded-[8px] border border-border bg-surface p-4 text-left transition-[border-color,box-shadow] hover:border-border-2 hover:shadow-card disabled:opacity-60"
              >
                <div className="flex items-center gap-2.5">
                  <span className="grid h-8 w-8 flex-none place-items-center rounded-[6px] bg-violet-soft text-violet">
                    {tpl.icon ? <PageIcon icon={tpl.icon} size={18} /> : <LayoutTemplate size={16} strokeWidth={1.75} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium text-text">{tpl.title || t("untitled")}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[12.5px] text-text-3">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {tpl.project ? (
                      <>
                        <ProjectIcon projectKey={tpl.project.key} size={14} />
                        <span className="truncate">{tpl.project.name}</span>
                      </>
                    ) : (
                      <span>{t("index.workspaceTemplate")}</span>
                    )}
                  </span>
                  <span className="flex-none font-medium text-accent-text opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                    {usingTemplateId === tpl.id ? t("index.usingTemplateEllipsis") : t("index.useTemplate")}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 type-headline">{t("index.recentlyEdited")}</h2>
        {pages.length === 0 ? (
          <EmptyState
            icon={<FileText size={18} />}
            title={t("index.emptyTitle")}
            description={t("index.emptyStateText")}
            action={
              <Button variant="primary" onClick={() => createPage()}>
                <Plus size={15} strokeWidth={2.25} />
                {t("index.newPageButton")}
              </Button>
            }
          />
        ) : (
          <div className="overflow-hidden rounded-[8px] border border-border">
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,220px)_140px] gap-4 border-b border-border bg-surface-2 px-4 py-2 text-[12.5px] font-medium text-text-3 sm:grid">
              <span>{t("index.colTitle")}</span>
              <span>{t("index.colLocation")}</span>
              <span className="text-right">{t("index.colUpdated")}</span>
            </div>
            {pages.map((page) => {
              const updated = new Date(page.updatedAt);
              return (
                <Link
                  key={page.id}
                  to="/docs/$pageId"
                  params={{ pageId: page.id }}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border bg-surface px-4 py-2.5 last:border-b-0 hover:bg-surface-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,220px)_140px]"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <PageIcon icon={page.icon} size={17} />
                    <span className="truncate text-[14.5px] text-text">{page.title || <span className="text-text-3">{t("untitled")}</span>}</span>
                  </span>
                  <span className="hidden truncate text-[13px] text-text-3 sm:block">{locationOf(page.parentPageId)}</span>
                  <span className="text-right text-[13px] tabular-nums text-text-3" title={updated.toLocaleString(intlLocale)}>
                    {relativeTime(updated, intlLocale)}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </PageContainer>
  );
}
