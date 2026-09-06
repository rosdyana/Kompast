import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import { listPageVersionsFn, getPageVersionBlocksFn } from "@/lib/server-fns/pages";

type Versions = Awaited<ReturnType<typeof listPageVersionsFn>>;

/** Only the two members this component actually calls — sidesteps BlockNoteEditor's generic variance. */
interface ReplaceableEditor {
  document: unknown[];
  replaceBlocks(blocksToRemove: unknown[], blocksToInsert: unknown[]): void;
}

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };

export function VersionHistory({ pageId, editor }: { pageId: string; editor: ReplaceableEditor }) {
  const { t, i18n } = useTranslation("docs");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Versions | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  async function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setLoading(true);
    try {
      setData(await listPageVersionsFn({ data: pageId }));
    } finally {
      setLoading(false);
    }
  }

  async function restore(versionId: string) {
    setRestoringId(versionId);
    try {
      const blocks = await getPageVersionBlocksFn({ data: { pageId, versionId } });
      editor.replaceBlocks(editor.document, blocks);
      setOpen(false);
    } finally {
      setRestoringId(null);
    }
  }

  const usersById = new Map((data?.users ?? []).map((u) => [u.id, u]));

  return (
    <div className="relative">
      <Button variant="outline" className="text-[12px]" onClick={toggleOpen}>
        {t("versionHistory.historyButton")}
      </Button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-20 max-h-[360px] w-[300px] overflow-y-auto rounded-[9px] border border-border bg-surface shadow-kp">
          {loading && <p className="px-3 py-3 text-[12px] text-text-3">{t("loadingEllipsis")}</p>}
          {!loading && data?.versions.length === 0 && (
            <p className="px-3 py-3 text-[12px] text-text-3">{t("versionHistory.noHistoryYet")}</p>
          )}
          {!loading &&
            data?.versions.map((v) => {
              const author = v.authorId ? usersById.get(v.authorId) : undefined;
              return (
                <div key={v.id} className="flex items-center gap-2 border-b border-border px-3 py-2 text-[12px] last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{new Date(v.createdAt).toLocaleString(intlLocale)}</p>
                    <p className="truncate text-[10.5px] text-text-3">{author?.name ?? t("versionHistory.unknownAuthor")}</p>
                  </div>
                  <button
                    onClick={() => restore(v.id)}
                    disabled={restoringId !== null}
                    className="flex-none rounded-[7px] border border-border px-2 py-1 text-[11px] hover:bg-surface-3 disabled:opacity-50"
                  >
                    {restoringId === v.id ? "…" : t("restore")}
                  </button>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
