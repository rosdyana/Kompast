import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
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
    <div className="mx-auto max-w-[820px] px-8 pb-16 pt-9">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Docs</h1>
        <Button variant="primary" onClick={newPage} disabled={creating}>
          + Halaman baru
        </Button>
      </div>

      {data.templates.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-[13px] font-semibold">Template</h2>
          <div className="flex flex-col gap-1.5">
            {data.templates.map((t) => (
              <div key={t.id} className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-[13px]">
                <span>{t.icon || "▤"}</span>
                <span className="min-w-0 flex-1 truncate">{t.title || "Tanpa judul"}</span>
                <Button
                  variant="outline"
                  className="text-[11.5px]"
                  onClick={() => useTemplate(t.id)}
                  disabled={usingTemplateId !== null}
                >
                  {usingTemplateId === t.id ? "Membuat…" : "Gunakan"}
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.pages.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-10 text-center text-sm text-text-3">
          Belum ada halaman. Docs adalah ruang kolaboratif untuk catatan, spesifikasi, dan dokumentasi tim — mirip Notion,
          bisa ditautkan langsung ke tiket kanban.
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-surface p-2">
          <DocsTree pages={data.pages} />
        </div>
      )}
    </div>
  );
}
