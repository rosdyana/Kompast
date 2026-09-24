import { useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { Dialog } from "@kompast/ui/Dialog";
import { Avatar } from "@kompast/ui/Avatar";
import { Spinner } from "@kompast/ui/EmptyState";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import { listPageVersionsFn, getPageVersionBlocksFn } from "@/lib/server-fns/pages";
import { cn } from "@/lib/cn";
import { relativeTime } from "./relative-time";

type Versions = Awaited<ReturnType<typeof listPageVersionsFn>>;

/** Only the two members this component actually calls — sidesteps BlockNoteEditor's generic variance. */
export interface ReplaceableEditor {
  document: unknown[];
  replaceBlocks(blocksToRemove: unknown[], blocksToInsert: unknown[]): void;
}

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };

interface PreviewBlock {
  type?: string;
  props?: { level?: number };
  content?: unknown;
  children?: PreviewBlock[];
}

function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: string; text?: string; props?: { title?: string; projectKey?: string; keySeq?: string } }) =>
      c.type === "text" ? c.text ?? "" : c.props?.title ?? (c.props?.projectKey ? `${c.props.projectKey}-${c.props.keySeq}` : ""),
    )
    .join("");
}

/** A lightweight read-only outline of a snapshot — enough to recognize the version before restoring it. */
function SnapshotPreview({ blocks, emptyText }: { blocks: PreviewBlock[]; emptyText: string }) {
  const rows: { key: string; depth: number; block: PreviewBlock; text: string }[] = [];
  const walk = (list: PreviewBlock[], depth: number, prefix: string) =>
    list.forEach((b, i) => {
      rows.push({ key: `${prefix}${i}`, depth, block: b, text: inlineText(b.content) });
      if (b.children?.length) walk(b.children, depth + 1, `${prefix}${i}.`);
    });
  walk(blocks, 0, "");
  const visible = rows.filter((r) => r.text.trim() || r.block.type === "divider");
  if (visible.length === 0) return <p className="text-[14px] text-text-3">{emptyText}</p>;
  return (
    <div className="kp-doc flex flex-col gap-1 text-[15px] leading-relaxed">
      {visible.map(({ key, depth, block, text }) => {
        const pad = { paddingLeft: depth * 20 };
        if (block.type === "divider") return <hr key={key} className="my-2 border-border-2" />;
        if (block.type === "heading") {
          const size = block.props?.level === 1 ? "text-[22px]" : block.props?.level === 2 ? "text-[18px]" : "text-[16px]";
          return (
            <p key={key} style={pad} className={cn("mt-3 font-semibold", size)}>
              {text}
            </p>
          );
        }
        const bullet =
          block.type === "bulletListItem" ? "•" : block.type === "numberedListItem" ? "1." : block.type === "checkListItem" ? "☐" : null;
        if (block.type === "quote")
          return (
            <p key={key} style={pad} className="border-l-[3px] border-text pl-3">
              {text}
            </p>
          );
        if (block.type === "codeBlock")
          return (
            <pre key={key} style={pad} className="overflow-x-auto rounded-[6px] bg-surface-2 p-3 font-mono text-[13px]">
              {text}
            </pre>
          );
        return (
          <p key={key} style={pad} className="flex gap-2">
            {bullet && <span className="flex-none text-text-3">{bullet}</span>}
            <span>{text}</span>
          </p>
        );
      })}
    </div>
  );
}

/**
 * Version history as a modal: versions on the left (author, time), a
 * read-only preview of the selected snapshot on the right, and Restore —
 * which applies the snapshot through the LIVE collaborative editor
 * (replaceBlocks), never by overwriting stored Yjs state.
 */
export function VersionHistoryDialog({
  open,
  onClose,
  pageId,
  editor,
  canRestore,
}: {
  open: boolean;
  onClose: () => void;
  pageId: string;
  editor: ReplaceableEditor | null;
  canRestore: boolean;
}) {
  const { t, i18n } = useTranslation(["docs", "common"]);
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const toast = useToast();
  const [data, setData] = useState<Versions | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewBlock[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setData(null);
    setSelectedId(null);
    setPreview(null);
    setError(null);
    listPageVersionsFn({ data: pageId })
      .then((res) => {
        setData(res);
        if (res.versions[0]) setSelectedId(res.versions[0].id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [open, pageId]);

  useEffect(() => {
    if (!open || !selectedId) return;
    let cancelled = false;
    setPreviewLoading(true);
    getPageVersionBlocksFn({ data: { pageId, versionId: selectedId } })
      .then((blocks) => !cancelled && setPreview(blocks as PreviewBlock[]))
      .catch(() => !cancelled && setPreview([]))
      .finally(() => !cancelled && setPreviewLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, pageId, selectedId]);

  async function restore() {
    if (!editor || !selectedId) return;
    setRestoring(true);
    try {
      const blocks = await getPageVersionBlocksFn({ data: { pageId, versionId: selectedId } });
      editor.replaceBlocks(editor.document, blocks);
      toast.show({ title: t("versionHistory.restored") });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoring(false);
    }
  }

  const usersById = new Map((data?.users ?? []).map((u) => [u.id, u]));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={t("versionHistory.panelTitle")}
      description={t("versionHistory.autosaveNote")}
      closeLabel={t("common:close")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common:cancel")}
          </Button>
          {canRestore && (data?.versions.length ?? 0) > 0 && (
            <Button variant="primary" onClick={restore} disabled={!selectedId || restoring || !editor}>
              <RotateCcw size={14} />
              {restoring ? t("common:saving") : t("versionHistory.restoreThis")}
            </Button>
          )}
        </>
      }
    >
      {error && <p className="mb-3 rounded-[6px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
      {!data ? (
        <div className="grid place-items-center py-16">
          <Spinner size={18} />
        </div>
      ) : data.versions.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-14 text-center">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-surface-3 text-text-3">
            <History size={18} />
          </span>
          <p className="max-w-[380px] text-[14px] text-text-2">{t("versionHistory.noHistoryYet")}</p>
        </div>
      ) : (
        <div className="grid min-h-[420px] grid-cols-1 gap-0 overflow-hidden rounded-[8px] border border-border sm:grid-cols-[240px_1fr]">
          <div className="max-h-[56vh] overflow-y-auto border-b border-border bg-surface-2 p-1.5 sm:border-b-0 sm:border-r">
            {data.versions.map((v) => {
              const author = v.authorId ? usersById.get(v.authorId) : undefined;
              const selected = v.id === selectedId;
              const created = new Date(v.createdAt);
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setSelectedId(v.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-left",
                    selected ? "bg-surface-4" : "hover:bg-surface-3",
                  )}
                >
                  <Avatar name={author?.name ?? "?"} size={24} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-text" title={created.toLocaleString(intlLocale)}>
                      {relativeTime(created, intlLocale)}
                    </span>
                    <span className="block truncate text-[12px] text-text-3">{author?.name ?? t("versionHistory.unknownAuthor")}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="max-h-[56vh] overflow-y-auto px-6 py-5">
            {previewLoading || !preview ? (
              <div className="grid place-items-center py-16">
                <Spinner size={18} />
              </div>
            ) : (
              <SnapshotPreview blocks={preview} emptyText={t("versionHistory.previewEmpty")} />
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Inline trigger for embedded editors (sprint minutes / retro tabs). */
export function VersionHistory({ pageId, editor }: { pageId: string; editor: ReplaceableEditor }) {
  const { t } = useTranslation("docs");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <History size={14} strokeWidth={1.75} />
        {t("versionHistory.historyButton")}
      </Button>
      <VersionHistoryDialog open={open} onClose={() => setOpen(false)} pageId={pageId} editor={editor} canRestore />
    </>
  );
}
