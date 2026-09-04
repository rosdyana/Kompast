import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { listPageTreeFn, createPageFn } from "@/lib/server-fns/pages";
import { DocsTree } from "@/components/docs/DocsTree";

export const Route = createFileRoute("/_app/docs/")({
  loader: () => listPageTreeFn(),
  component: DocsIndexPage,
});

function DocsIndexPage() {
  const data = Route.useLoaderData();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  async function newPage() {
    setCreating(true);
    try {
      const page = await createPageFn({ data: {} });
      await navigate({ to: "/docs/$pageId", params: { pageId: page.id } });
    } finally {
      setCreating(false);
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
