import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Archive, Lock, Share2 } from "lucide-react";
import { Avatar } from "@kompast/ui/Avatar";
import { Badge } from "@kompast/ui/Badge";
import { Button } from "@kompast/ui/Button";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation } from "@kompast/i18n";
import { listDepartedMemberPagesFn, recoverDepartedMemberPageFn } from "@/lib/server-fns/pages";
import { PageIcon } from "@/components/docs/DocsTree";
import { SettingsSection } from "./SettingsSection";

type Tree = Awaited<ReturnType<typeof listDepartedMemberPagesFn>>[number];

/**
 * Super admin only: Private/Shared pages whose owner has left the workspace.
 * RLS shows the super admin these and nothing else of anyone's private
 * pages (see packages/core/src/page-recovery.ts). Loaded on open, not with
 * the settings route: it's a rare, admin-only screen.
 */
export function DepartedPagesTab() {
  const { t } = useTranslation(["settings", "common"]);
  const toast = useToast();
  const router = useRouter();
  const [trees, setTrees] = useState<Tree[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setTrees(await listDepartedMemberPagesFn());
  }
  useEffect(() => {
    void load();
  }, []);

  async function recover(tree: Tree, to: "me" | "workspace") {
    setBusy(tree.rootId);
    try {
      await recoverDepartedMemberPageFn({ data: { pageId: tree.rootId, to } });
      toast.show({ title: to === "me" ? t("departedPages.recoveredToMe") : t("departedPages.recoveredToWorkspace"), description: tree.title || t("departedPages.untitled") });
      await load();
      await router.invalidate();
    } catch (err) {
      toast.show({ tone: "error", title: t("common:somethingWentWrong"), description: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsSection title={t("tabs.departedPages")} description={t("departedPages.description")}>
      {trees === null ? (
        <p className="type-body text-text-3">{t("common:loading")}</p>
      ) : trees.length === 0 ? (
        <p className="type-body text-text-2">{t("departedPages.empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-[8px] border border-border">
          {trees.map((tree) => (
            <li key={tree.rootId} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <PageIcon icon={tree.icon} size={18} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium text-text">{tree.title || t("departedPages.untitled")}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-text-3">
                  <Avatar name={tree.owner.name} size={16} />
                  <span>{tree.owner.name}</span>
                  <span aria-hidden>·</span>
                  <span>{t("departedPages.pageCount", { count: tree.pageCount })}</span>
                </p>
              </div>
              {tree.sharedWithCount > 0 ? (
                <Badge>
                  <Share2 size={12} /> {t("departedPages.sharedWith", { count: tree.sharedWithCount })}
                </Badge>
              ) : (
                <Badge>
                  <Lock size={12} /> {t("departedPages.private")}
                </Badge>
              )}
              {tree.archived && (
                <Badge>
                  <Archive size={12} /> {t("departedPages.inTrash")}
                </Badge>
              )}
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => recover(tree, "me")}>
                  {t("departedPages.takeOwnership")}
                </Button>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => recover(tree, "workspace")}>
                  {t("departedPages.moveToWorkspace")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
