import { useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { ChevronRight, Plus, UsersRound } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { Card } from "@kompast/ui/Card";
import { Badge } from "@kompast/ui/Badge";
import { EmptyState } from "@kompast/ui/EmptyState";
import { NativeSelect } from "@kompast/ui/Input";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation } from "@kompast/i18n";
import { transferSuperAdminFn, type listTeamsFn } from "@/lib/server-fns/teams";
import type { listMembersFn } from "@/lib/server-fns/members";
import { SettingsSection } from "./SettingsSection";
import { ConfirmDialog } from "./ConfirmDialog";

export function TeamsTab({
  teams,
  members,
}: {
  teams: Awaited<ReturnType<typeof listTeamsFn>>;
  members: Awaited<ReturnType<typeof listMembersFn>>["members"];
}) {
  const { t } = useTranslation("teams");

  return (
    <>
      <SettingsSection
        title={t("teams")}
        description={t("overviewSubtitle")}
        aside={
          <Link to="/teams/new" className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border-2 bg-surface px-3 text-[14px] font-medium hover:bg-surface-2">
            <Plus size={15} />
            {t("newTeamPageTitle")}
          </Link>
        }
      >
        {teams.length === 0 ? (
          <EmptyState icon={<UsersRound size={18} />} title={t("noTeamsYet")} />
        ) : (
          <Card className="overflow-hidden">
            {teams.map((team) => (
              <Link
                key={team.id}
                to="/teams/$teamId"
                params={{ teamId: team.id }}
                className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 hover:bg-surface-2"
              >
                <span className="grid h-8 w-8 flex-none place-items-center rounded-[8px] bg-indigo-soft text-indigo">
                  <UsersRound size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium">{team.name}</p>
                  <p className="text-[12.5px] text-text-3">
                    {t("teamMemberCount", { count: team.memberCount })} · {t("teamProjectCount", { count: team.projectCount })}
                  </p>
                </div>
                {team.myRole === "admin" && <Badge tone="accent">{t("adminBadge")}</Badge>}
                <ChevronRight size={16} className="flex-none text-text-3" />
              </Link>
            ))}
          </Card>
        )}
      </SettingsSection>

      <TransferSuperAdmin members={members} />
    </>
  );
}

function TransferSuperAdmin({ members }: { members: Awaited<ReturnType<typeof listMembersFn>>["members"] }) {
  const { t } = useTranslation("teams");
  const router = useRouter();
  const toast = useToast();
  const [newHolderUserId, setNewHolderUserId] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const target = members.find((m) => m.userId === newHolderUserId);

  return (
    <SettingsSection title={t("transferHeading")} description={t("transferSubtitle")}>
      <Card className="flex flex-col gap-2 p-4 sm:flex-row">
        <NativeSelect value={newHolderUserId} onChange={(e) => setNewHolderUserId(e.target.value)} className="sm:flex-1" aria-label={t("transferMemberSelectPlaceholder")}>
          <option value="">{t("transferMemberSelectPlaceholder")}</option>
          {members.map((m) => (
            <option key={m.id} value={m.userId}>
              {m.name} ({m.email})
            </option>
          ))}
        </NativeSelect>
        <Button variant="outline" onClick={() => setConfirmOpen(true)} disabled={!newHolderUserId}>
          {t("transfer")}
        </Button>
      </Card>
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("transferConfirmTitle", { name: target?.name ?? "" })}
        body={t("transferConfirmBody")}
        confirmLabel={t("transfer")}
        cancelLabel={t("cancel")}
        onConfirm={async () => {
          await transferSuperAdminFn({ data: { newHolderUserId } });
          setNewHolderUserId("");
          toast.show({ title: t("transferDone") });
          await router.invalidate();
        }}
      />
    </SettingsSection>
  );
}
