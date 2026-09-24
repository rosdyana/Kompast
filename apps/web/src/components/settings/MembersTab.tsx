import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Mail, X } from "lucide-react";
import { Button, IconButton } from "@kompast/ui/Button";
import { Card } from "@kompast/ui/Card";
import { Badge } from "@kompast/ui/Badge";
import { Avatar } from "@kompast/ui/Avatar";
import { NativeSelect, TextField } from "@kompast/ui/Input";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation } from "@kompast/i18n";
import { inviteMemberFn, cancelInvitationFn, type listMembersFn } from "@/lib/server-fns/members";
import { SettingsSection } from "./SettingsSection";

export function MembersTab({ data }: { data: Awaited<ReturnType<typeof listMembersFn>> }) {
  const { t } = useTranslation("settings");
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roleLabel = (r: string) => (r === "owner" ? t("members.roleOwner") : r === "admin" ? t("members.adminRoleLabel") : t("members.memberRoleLabel"));

  async function invite() {
    const address = email.trim();
    if (!address) return;
    setInviting(true);
    setError(null);
    try {
      await inviteMemberFn({ data: { email: address, role } });
      setEmail("");
      toast.show({ title: t("members.inviteSent", { email: address }) });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("members.inviteFailed"));
    } finally {
      setInviting(false);
    }
  }

  async function cancel(invitationId: string) {
    try {
      await cancelInvitationFn({ data: invitationId });
      await router.invalidate();
    } catch {
      toast.show({ tone: "error", title: t("members.cancelFailed") });
    }
  }

  return (
    <SettingsSection title={t("tabs.members")} description={t("members.subtitle")} aside={<Badge>{t("members.memberCount", { count: data.members.length })}</Badge>}>
      <Card className="mb-8 p-4">
        <p className="mb-1 text-[14px] font-medium">{t("members.inviteHeading")}</p>
        <p className="mb-3 text-[13px] text-text-2">{t("members.inviteHint")}</p>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            invite();
          }}
        >
          <TextField
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("members.emailPlaceholder")}
            aria-label={t("members.emailPlaceholder")}
            aria-invalid={!!error}
            className="sm:flex-1"
          />
          <NativeSelect value={role} onChange={(e) => setRole(e.target.value as typeof role)} className="sm:w-[130px]" aria-label={t("members.tableRole")}>
            <option value="member">{t("members.memberRoleLabel")}</option>
            <option value="admin">{t("members.adminRoleLabel")}</option>
          </NativeSelect>
          <Button type="submit" variant="primary" disabled={inviting || !email.trim()}>
            {inviting ? t("members.invitingEllipsis") : t("members.invite")}
          </Button>
        </form>
        {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
      </Card>

      {data.invitations.length > 0 && (
        <div className="mb-8">
          <h3 className="mb-2 text-[14px] font-medium">{t("members.pendingInvitesHeading")}</h3>
          <Card className="overflow-hidden">
            {data.invitations.map((inv) => (
              <div key={inv.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
                <span className="grid h-7 w-7 flex-none place-items-center rounded-full bg-surface-3 text-text-3">
                  <Mail size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px]">{inv.email}</p>
                  <p className="text-[12.5px] text-text-3">{t("members.invitedAs", { role: roleLabel(inv.role ?? "member") })}</p>
                </div>
                <IconButton aria-label={t("members.cancel")} title={t("members.cancel")} onClick={() => cancel(inv.id)} className="hover:text-danger">
                  <X size={15} />
                </IconButton>
              </div>
            ))}
          </Card>
        </div>
      )}

      <h3 className="mb-2 text-[14px] font-medium">{t("members.currentMembersHeading")}</h3>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-left text-[14px]">
          <thead>
            <tr className="border-b border-border text-[12.5px] text-text-3">
              <th className="px-4 py-2 font-medium">{t("members.tableName")}</th>
              <th className="px-4 py-2 font-medium">{t("members.tableRole")}</th>
            </tr>
          </thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.id} className="border-b border-border last:border-b-0 hover:bg-surface-2">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-3">
                    <Avatar name={m.name} size={28} />
                    <div className="min-w-0">
                      <p className="truncate font-medium">{m.name}</p>
                      <p className="truncate text-[12.5px] text-text-3">{m.email}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={m.role === "owner" ? "indigo" : m.role === "admin" ? "accent" : "neutral"}>{roleLabel(m.role)}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </SettingsSection>
  );
}
