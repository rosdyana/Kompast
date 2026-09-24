import { useState } from "react";
import { FileArchive, FileImage, FileSpreadsheet, FileText, File as FileIcon, Trash2, Upload } from "lucide-react";
import { Spinner } from "@kompast/ui/EmptyState";
import { useTranslation } from "@kompast/i18n";
import { cn } from "@/lib/cn";
import { relativeTime } from "./time";

export interface AttachmentItem {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  downloadUrl: string;
  createdAt: string | Date;
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(a: AttachmentItem) {
  const ext = a.fileName.split(".").pop()?.toLowerCase() ?? "";
  if (a.contentType.startsWith("image/")) return FileImage;
  if (["zip", "gz", "tar", "rar", "7z"].includes(ext)) return FileArchive;
  if (["csv", "xls", "xlsx", "numbers"].includes(ext)) return FileSpreadsheet;
  if (a.contentType.startsWith("text/") || ["pdf", "doc", "docx", "md", "txt"].includes(ext)) return FileText;
  return FileIcon;
}

/**
 * Attachment tiles (image thumbnails where possible) plus a drop zone. The
 * whole section accepts dropped files; uploading tiles show a spinner.
 */
export function Attachments({
  attachments,
  uploading,
  onUpload,
  onRemove,
  intlLocale,
}: {
  attachments: AttachmentItem[];
  uploading: string[];
  onUpload: (files: File[]) => void;
  onRemove: (id: string) => void;
  intlLocale: string;
}) {
  const { t } = useTranslation("issue");
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length) onUpload(files);
      }}
      className={cn("rounded-[8px] transition-colors", dragOver && "bg-accent-soft outline-2 outline-dashed outline-accent")}
    >
      {attachments.length === 0 && uploading.length === 0 ? (
        <div className="flex items-center gap-2 rounded-[8px] border border-dashed border-border-2 px-4 py-4 text-[13px] text-text-3">
          <Upload size={15} />
          {dragOver ? t("dropToAttach") : t("attachHint")}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-2">
          {attachments.map((a) => {
            const Icon = iconFor(a);
            const isImage = a.contentType.startsWith("image/");
            return (
              <div key={a.id} className="group/tile relative overflow-hidden rounded-[8px] border border-border bg-surface hover:border-border-2">
                <a href={a.downloadUrl} target="_blank" rel="noreferrer" className="block">
                  <div className="grid h-[84px] place-items-center overflow-hidden bg-surface-2">
                    {isImage ? (
                      <img src={a.downloadUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <Icon size={28} strokeWidth={1.5} className="text-text-3" />
                    )}
                  </div>
                  <div className="px-2.5 py-2">
                    <p className="truncate text-[13px] font-medium text-text" title={a.fileName}>
                      {a.fileName}
                    </p>
                    <p className="text-[12px] text-text-3">
                      {formatBytes(a.sizeBytes)} · {relativeTime(a.createdAt, intlLocale)}
                    </p>
                  </div>
                </a>
                <button
                  type="button"
                  onClick={() => onRemove(a.id)}
                  aria-label={t("deleteAttachment")}
                  title={t("deleteAttachment")}
                  className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-[6px] border border-border bg-surface text-text-2 opacity-0 shadow-card transition-opacity hover:text-danger focus-visible:opacity-100 group-hover/tile:opacity-100"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
          {uploading.map((name) => (
            <div key={name} className="overflow-hidden rounded-[8px] border border-dashed border-border-2 bg-surface-2">
              <div className="grid h-[84px] place-items-center">
                <Spinner size={18} />
              </div>
              <p className="truncate px-2.5 py-2 text-[13px] text-text-2">{name}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
