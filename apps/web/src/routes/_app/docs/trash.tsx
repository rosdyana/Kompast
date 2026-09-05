import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Button } from "@kompast/ui/Button";
import { listTrashFn, restorePageFn, permanentlyDeletePageFn } from "@/lib/server-fns/pages";

export const Route = createFileRoute("/_app/docs/trash")({
  loader: () => listTrashFn(),
  component: TrashPage,
});

function TrashPage() {
  const pages = Route.useLoaderData();
  const router = useRouter();

  async function restore(pageId: string) {
    await restorePageFn({ data: pageId });
    await router.invalidate();
  }

  async function deleteForever(pageId: string, title: string) {
    if (!window.confirm(`Hapus permanen "${title || "Tanpa judul"}"? Tindakan ini tidak bisa dibatalkan.`)) return;
    await permanentlyDeletePageFn({ data: pageId });
    await router.invalidate();
  }

  return (
    <div className="mx-auto max-w-[820px] px-8 pb-16 pt-9">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link to="/docs" className="mb-1 inline-block text-xs text-text-3 hover:text-text-2">
            ← Docs
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Sampah</h1>
        </div>
      </div>

      {pages.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-10 text-center text-sm text-text-3">
          Sampah kosong.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {pages.map((page) => (
            <div key={page.id} className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5 text-[13px]">
              <span>{page.icon || "▤"}</span>
              <span className="min-w-0 flex-1 truncate">{page.title || "Tanpa judul"}</span>
              <span className="flex-none text-[11px] text-text-3">
                Diarsipkan {page.archivedAt ? new Date(page.archivedAt).toLocaleDateString("id-ID") : ""}
              </span>
              <Button variant="outline" className="text-[11.5px]" onClick={() => restore(page.id)}>
                Pulihkan
              </Button>
              <button
                onClick={() => deleteForever(page.id, page.title)}
                className="rounded-md px-2 py-1 text-[11.5px] text-text-3 hover:bg-danger-soft hover:text-danger"
              >
                Hapus permanen
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
