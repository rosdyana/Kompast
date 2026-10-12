import { createFileRoute, redirect, useLoaderData, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Mail, Trash2, UserMinus, UsersRound, X } from "lucide-react";
import { Card } from "@kompast/ui/Card";
import { Button, IconButton } from "@kompast/ui/Button";
import { Avatar } from "@kompast/ui/Avatar";
import { Dialog } from "@kompast/ui/Dialog";
import { FormField, NativeSelect, TextField } from "@kompast/ui/Input";
import { PageContainer } from "@kompast/ui/PageContainer";
import { PageHeader } from "@kompast/ui/PageHeader";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation } from "@kompast/i18n";
import {
  getTeamManagementFn,
  addTeamMemberFn,
  removeTeamMemberFn,
  setTeamMemberRoleFn,
  inviteToTeamFn,
  cancelTeamInvitationFn,
  renameTeamFn,
  getTeamDeletionImpactFn,
  deleteTeamFn,
} from "@/lib/server-fns/teams";
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

      <RenameTeam teamId={teamId} currentName={teamName} />

      <InviteByEmail teamId={teamId} invitations={data.invitations} />

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

      {shell.isSuperAdmin && <DangerZone teamId={teamId} teamName={teamName} otherTeams={shell.teams.filter((tm) => tm.id !== teamId)} />}

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

/**
 * Inviting someone who isn't in the workspace yet. They join as a plain
 * workspace member, straight into this team with the chosen team role —
 * which is how a team admin grows their team without needing a workspace
 * admin (see packages/core/src/team.ts createTeamInvitation).
 */
function InviteByEmail({ teamId, invitations }: { teamId: string; invitations: Awaited<ReturnType<typeof getTeamManagementFn>>["invitations"] }) {
  const { t } = useTranslation("teams");
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [teamRole, setTeamRole] = useState<"member" | "admin">("member");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setSending(true);
    setError(null);
    try {
      const { created } = await inviteToTeamFn({ data: { teamId, email: email.trim(), teamRole } });
      setEmail("");
      toast.show({ title: created ? t("inviteSent") : t("inviteAlreadyPending") });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("inviteFailed"));
    } finally {
      setSending(false);
    }
  }

  async function cancel(invitationId: string) {
    await cancelTeamInvitationFn({ data: { teamId, invitationId } });
    toast.show({ title: t("inviteCanceled") });
    await router.invalidate();
  }

  return (
    <Card className="mb-8 p-4">
      <p className="text-[14px] font-medium">{t("inviteHeading")}</p>
      <p className="mb-3 type-small text-text-3">{t("inviteSubtitle")}</p>
      <form onSubmit={invite} className="flex flex-col gap-2 sm:flex-row">
        <TextField
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("inviteEmailPlaceholder")}
          aria-label={t("inviteEmailPlaceholder")}
          className="sm:flex-1"
        />
        <NativeSelect value={teamRole} onChange={(e) => setTeamRole(e.target.value as "member" | "admin")} aria-label={t("inviteRoleLabel")} className="sm:w-[150px]">
          <option value="member">{t("memberRoleLabel")}</option>
          <option value="admin">{t("adminRoleLabel")}</option>
        </NativeSelect>
        <Button type="submit" variant="primary" disabled={sending || !email.trim()}>
          {sending ? t("invitingEllipsis") : t("invite")}
        </Button>
      </form>
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}

      {invitations.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-1.5 text-[12.5px] font-semibold text-text-3">{t("pendingInvitesHeading")}</p>
          {invitations.map((inv) => (
            <div key={inv.id} className="flex items-center gap-2.5 py-1.5">
              <Mail size={15} className="flex-none text-text-3" />
              <span className="min-w-0 flex-1 truncate text-[14px]">{inv.email}</span>
              <span className="text-[12.5px] text-text-3">{inv.teamRole === "admin" ? t("adminRoleLabel") : t("memberRoleLabel")}</span>
              <IconButton aria-label={t("cancelInvite")} title={t("cancelInvite")} onClick={() => cancel(inv.id)} className="hover:text-danger">
                <X size={15} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function RenameTeam({ teamId, currentName }: { teamId: string; currentName: string }) {
  const { t } = useTranslation("teams");
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(currentName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setName(currentName), [currentName]);
  const trimmed = name.trim();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await renameTeamFn({ data: { teamId, name: trimmed } });
      toast.show({ title: t("renamed") });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("renameFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mb-8 p-4">
      <p className="mb-3 text-[14px] font-medium">{t("nameLabel")}</p>
      <form onSubmit={save} className="flex flex-col gap-2 sm:flex-row">
        <TextField value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label={t("nameLabel")} className="sm:flex-1" />
        <Button type="submit" variant="outline" disabled={saving || !trimmed || trimmed === currentName}>
          {saving ? t("savingEllipsis") : t("rename")}
        </Button>
      </form>
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
    </Card>
  );
}

/** Super admin only — deleting a team is as workspace-shaping as creating one. */
function DangerZone({ teamId, teamName, otherTeams }: { teamId: string; teamName: string; otherTeams: { id: string; name: string }[] }) {
  const { t } = useTranslation("teams");
  const [open, setOpen] = useState(false);
  return (
    <>
      <h2 className="mb-2 mt-10 type-headline text-danger">{t("dangerZone")}</h2>
      <Card className="flex flex-col gap-3 border-danger/40 p-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium">{t("deleteTeam")}</p>
          <p className="type-small text-text-3">{t("deleteTeamSubtitle")}</p>
        </div>
        <Button variant="danger" onClick={() => setOpen(true)}>
          <Trash2 size={15} />
          {t("deleteTeam")}
        </Button>
      </Card>
      {open && <DeleteTeamDialog teamId={teamId} teamName={teamName} otherTeams={otherTeams} onClose={() => setOpen(false)} />}
    </>
  );
}

function DeleteTeamDialog({
  teamId,
  teamName,
  otherTeams,
  onClose,
}: {
  teamId: string;
  teamName: string;
  otherTeams: { id: string; name: string }[];
  onClose: () => void;
}) {
  const { t } = useTranslation("teams");
  const router = useRouter();
  const navigate = useNavigate();
  const toast = useToast();
  const [impact, setImpact] = useState<Awaited<ReturnType<typeof getTeamDeletionImpactFn>> | null>(null);
  const [transferTo, setTransferTo] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTeamDeletionImpactFn({ data: { teamId } })
      .then(setImpact)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [teamId]);

  const ownsContent = !!impact && (impact.projectCount > 0 || impact.docCount > 0);
  const noTarget = ownsContent && otherTeams.length === 0;
  const canDelete = !!impact && !noTarget && (!ownsContent || !!transferTo) && typed.trim() === teamName && !busy;
  const targetName = otherTeams.find((tm) => tm.id === transferTo)?.name ?? "";

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await deleteTeamFn({ data: { teamId, transferToTeamId: ownsContent ? transferTo : undefined } });
      toast.show({ title: t("teamDeleted", { name: teamName }) });
      await navigate({ to: "/settings", search: { tab: "teams" } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={t("deleteConfirmTitle", { name: teamName })}
      closeLabel={t("cancel")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button variant="danger" onClick={confirm} disabled={!canDelete}>
            {busy ? t("deletingEllipsis") : t("deleteTeam")}
          </Button>
        </>
      }
    >
      {!impact && !error && <p className="type-body text-text-3">{t("loadingImpact")}</p>}
      {impact && (
        <div className="flex flex-col gap-3">
          <p className="rounded-[6px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{t("deleteWarning")}</p>
          <ul className="list-disc pl-5 type-body text-text-2">
            <li>{t("impactMembers", { count: impact.memberCount })}</li>
            {impact.pendingInvitationCount > 0 && <li>{t("impactInvitations", { count: impact.pendingInvitationCount })}</li>}
            {!ownsContent && impact.archivedDocCount > 0 && <li>{t("impactTrashedDocs", { count: impact.archivedDocCount })}</li>}
          </ul>

          {ownsContent && (
            <FormField
              label={t("transferLabel", { projects: t("teamProjectCount", { count: impact.projectCount }), docs: t("teamDocCount", { count: impact.docCount }) })}
              hint={noTarget ? undefined : transferTo ? t("transferHint", { team: targetName }) : undefined}
            >
              {noTarget ? (
                <p className="type-body text-text-2">{t("transferNoTarget")}</p>
              ) : (
                <NativeSelect value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
                  <option value="">{t("transferPlaceholder")}</option>
                  {otherTeams.map((tm) => (
                    <option key={tm.id} value={tm.id}>
                      {tm.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
          )}

          {!noTarget && (
            <FormField label={t("typeToConfirm", { name: teamName })}>
              <TextField value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-autofocus />
            </FormField>
          )}
        </div>
      )}
      {error && <p className="mt-3 rounded-[6px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
    </Dialog>
  );
}
