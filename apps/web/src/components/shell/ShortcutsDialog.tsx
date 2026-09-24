import { Dialog } from "@kompast/ui/Dialog";
import { Kbd } from "@kompast/ui/Kbd";
import { useTranslation } from "@kompast/i18n";

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation(["nav", "common"]);
  const groups: { title: string; rows: { keys: string[]; label: string }[] }[] = [
    {
      title: t("shortcuts.global"),
      rows: [
        { keys: ["⌘", "K"], label: t("shortcuts.openPalette") },
        { keys: ["/"], label: t("shortcuts.search") },
        { keys: ["C"], label: t("shortcuts.createIssue") },
        { keys: ["⌘", "\\"], label: t("shortcuts.toggleSidebar") },
        { keys: ["?"], label: t("shortcuts.showShortcuts") },
      ],
    },
    {
      title: t("shortcuts.board"),
      rows: [{ keys: ["←", "→"], label: t("shortcuts.moveCard") }],
    },
  ];
  return (
    <Dialog open={open} onClose={onClose} size="sm" title={t("shortcuts.title")} closeLabel={t("common:close")}>
      <div className="flex flex-col gap-4">
        {groups.map((g) => (
          <section key={g.title}>
            <h3 className="mb-1.5 text-[12px] font-semibold text-text-3">{g.title}</h3>
            <div className="flex flex-col">
              {g.rows.map((r) => (
                <div key={r.label} className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
                  <span className="text-[13.5px] text-text">{r.label}</span>
                  <span className="flex flex-none items-center gap-1">
                    {r.keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
