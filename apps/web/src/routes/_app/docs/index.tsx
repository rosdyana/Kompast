import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { PageContainer } from "@kompast/ui/PageContainer";
import { PageHeader } from "@kompast/ui/PageHeader";
import { useTranslation } from "@kompast/i18n";
import { listPageTreeFn, createPageFn, listTemplatePagesFn, createPageFromTemplateFn } from "@/lib/server-fns/pages";
import { DocsTree } from "@/components/docs/DocsTree";

export const Route = createFileRoute("/_app/docs/")({
  loader: async () => {
    const [pageTree, templates] = await Promise.all([listPageTreeFn(), listTemplatePagesFn()]);
    return { ...pageTree, templates };
  },
  component: DocsIndexPage,
});

function DocsIndexPage() {
  const { t } = useTranslation("docs");
  const data = Route.useLoaderData();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [usingTemplateId, setUsingTemplateId] = useState<string | null>(null);

  async function newPage() {
    setCreating(true);
    try {
      const page = await createPageFn({ data: {} });
      await navigate({ to: "/docs/$pageId", params: { pageId: page.id } });
    } finally {
      setCreating(false);
    }
  }

  async function useTemplate(templatePageId: string) {
    setUsingTemplateId(templatePageId);
    try {
      const page = await createPageFromTemplateFn({ data: { templatePageId } });
      await navigate({ to: "/docs/$pageId", params: { pageId: page.id } });
    } finally {
      setUsingTemplateId(null);
    }
  }

  return (
    <PageContainer width="reading">
      <PageHeader
        title={t("docsBrand")}
        actions={
          <Button variant="primary" onClick={newPage} disabled={creating}>
            {t("index.newPageButton")}
          </Button>
        }
      />

      {data.templates.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-[13px] font-semibold">{t("index.templatesHeading")}</h2>
          <div className="flex flex-col gap-1.5">
            {data.templates.map((tpl) => (
              <div key={tpl.id} className="flex items-center gap-2.5 rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px]">
                <span>{tpl.icon || "▭"}</span>
                <span className="min-w-0 flex-1 truncate">{tpl.title || t("untitled")}</span>
                <Button
                  variant="outline"
                  className="text-[11.5px]"
                  onClick={() => useTemplate(tpl.id)}
                  disabled={usingTemplateId !== null}
                >
                  {usingTemplateId === tpl.id ? t("index.usingTemplateEllipsis") : t("index.useTemplate")}
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.pages.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-10 text-center text-sm text-text-3">
          {t("index.emptyStateText")}
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-surface p-2">
          <DocsTree pages={data.pages} />
        </div>
      )}
    </PageContainer>
  );
}
