import { createFileRoute, redirect, useLoaderData, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { UserMinus, UsersRound } from "lucide-react";
import { Card } from "@kompast/ui/Card";
import { Button, IconButton } from "@kompast/ui/Button";
import { Avatar } from "@kompast/ui/Avatar";
import { NativeSelect } from "@kompast/ui/Input";
import { PageContainer } from "@kompast/ui/PageContainer";
import { PageHeader } from "@kompast/ui/PageHeader";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation } from "@kompast/i18n";
import { getTeamManagementFn, addTeamMemberFn, removeTeamMemberFn, setTeamMemberRoleFn } from "@/lib/server-fns/teams";
import { ConfirmDialog } from "@/components/settings/ConfirmDialog";
import { usePageChrome } from "@/components/shell/WorkbenchContext";

export const Route = createFileRoute("/_app/teams/$teamId")({
  loader: async ({ params }) => {
    try {
      return await getTeamManagementFn({ data: { teamId: params.teamId } });
    } catch {
      // Sidebar/settings already hide this link for non-team-admins — someone
      // can still type the URL directly.
      throw redirect({ to: "/" });
    }
  },
  component: TeamManagementPage,
});

function TeamManagementPage() {
  const { t } = useTranslation("teams");
  const data = Route.useLoaderData();
  const shell = useLoaderData({ from: "/_app" });
  const { teamId } = Route.useParams();
  const router = useRouter();
  const toast = useToast();
  const [candidateUserId, setCandidateUserId] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null);
  const teamName = shell.teams.find((tm) => tm.id === teamId)?.name ?? t("manageTeamHeading");

  usePageChrome(
    {
      crumbs: [
        { label: t("settings"), link: { to: "/settings", search: { tab: "teams" } } },
        { label: teamName, icon: <UsersRound size={15} strokeWidth={1.75} className="text-text-3" /> },
      ],
    },
    [teamName, t],
  );

  const adminCount = data.members.filter((m) => m.role === "admin").length;

  async function addMember() {
    if (!candidateUserId) return;
    setAdding(true);
    setError(null);
    try {
      await addTeamMemberFn({ data: { teamId, userId: candidateUserId } });
      setCandidateUserId("");
      toast.show({ title: t("memberAdded") });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("addMemberFailed"));
    } finally {
      setAdding(false);
    }
  }

  async function setRole(userId: string, role: "admin" | "member") {
    try {
      await setTeamMemberRoleFn({ data: { teamId, userId, role } });
      await router.invalidate();
    } catch (err) {
      toast.show({ tone: "error", title: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <PageContainer width="standard">
      <PageHeader
        title={teamName}
        subtitle={t("manageTeamSubtitle")}
        icon={
          <span className="grid h-10 w-10 place-items-center rounded-[10px] bg-indigo-soft text-indigo">
            <UsersRound size={20} />
          </span>
        }
      />

      <Card className="mb-8 p-4">
        <p className="mb-3 text-[14px] font-medium">{t("addMemberHeading")}</p>
        {data.candidates.length === 0 ? (
          <p className="type-body text-text-3">{t("allMembersAlready")}</p>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <NativeSelect value={candidateUserId} onChange={(e) => setCandidateUserId(e.target.value)} className="sm:flex-1" aria-label={t("teamMemberSelectPlaceholder")}>
              <option value="">{t("teamMemberSelectPlaceholder")}</option>
              {data.candidates.map((c) => (
                <option key={c.userId} value={c.userId}>
                  {c.name} ({c.email})
                </option>
              ))}
            </NativeSelect>
            <Button variant="primary" onClick={addMember} disabled={adding || !candidateUserId}>
              {adding ? t("addingEllipsis") : t("add")}
            </Button>
          </div>
        )}
        {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
      </Card>

      <h2 className="mb-2 type-headline">{t("teamMembersHeading")}</h2>
      <Card className="overflow-hidden">
        {data.members.map((m) => {
          const lastAdmin = m.role === "admin" && adminCount <= 1;
          return (
            <div key={m.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 hover:bg-surface-2">
              <Avatar name={m.name} size={28} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium">{m.name}</p>
                <p className="truncate text-[12.5px] text-text-3">{m.email}</p>
              </div>
              <select
                value={m.role}
                onChange={(e) => setRole(m.userId, e.target.value as "admin" | "member")}
                disabled={lastAdmin}
                title={lastAdmin ? t("needsAdminTitle") : undefined}
                aria-label={`${m.name} role`}
                className="kp-field kp-select disabled:opacity-60"
              >
                <option value="member">{t("memberRoleLabel")}</option>
                <option value="admin">{t("adminRoleLabel")}</option>
              </select>
              <IconButton
                aria-label={t("remove")}
                title={lastAdmin ? t("needsAdminTitle") : t("remove")}
                disabled={lastAdmin}
                onClick={() => setRemoving({ userId: m.userId, name: m.name })}
                className="hover:text-danger"
              >
                <UserMinus size={15} />
              </IconButton>
            </div>
          );
        })}
      </Card>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={t("removeConfirmTitle", { name: removing?.name ?? "" })}
        body={t("removeConfirmBody")}
        confirmLabel={t("remove")}
        cancelLabel={t("cancel")}
        onConfirm={async () => {
          if (!removing) return;
          await removeTeamMemberFn({ data: { teamId, userId: removing.userId } });
          toast.show({ title: t("memberRemoved") });
          await router.invalidate();
        }}
      />
    </PageContainer>
  );
}
