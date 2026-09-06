import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@kompast/ui/Button";
import { Card } from "@kompast/ui/Card";
import { Badge } from "@kompast/ui/Badge";
import { Avatar } from "@kompast/ui/Avatar";
import { useTranslation } from "@kompast/i18n";
import { inviteMemberFn, cancelInvitationFn, type listMembersFn } from "@/lib/server-fns/members";

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function MembersTab({ data }: { data: Awaited<ReturnType<typeof listMembersFn>> }) {
  const { t } = useTranslation("settings");
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function invite() {
    if (!email.trim()) return;
    setInviting(true);
    setError(null);
    try {
      await inviteMemberFn({ data: { email: email.trim(), role } });
      setEmail("");
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("members.inviteFailed"));
    } finally {
      setInviting(false);
    }
  }

  async function cancel(invitationId: string) {
    await cancelInvitationFn({ data: invitationId });
    await router.invalidate();
  }

  return (
    <div>
      <p className="mb-6 type-body text-text-2">{t("members.subtitle")}</p>

      <section className="mb-8">
        <h2 className="mb-3 type-headline">{t("members.inviteHeading")}</h2>
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex gap-2">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && invite()}
              placeholder={t("members.emailPlaceholder")}
              className="min-w-0 flex-1 rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as typeof role)}
              className="kp-select rounded-[7px] border border-border-2 bg-surface px-2.5 py-2 text-[12.5px] outline-none"
            >
              <option value="member">{t("members.memberRoleLabel")}</option>
              <option value="admin">{t("members.adminRoleLabel")}</option>
            </select>
            <Button variant="primary" onClick={invite} disabled={inviting || !email.trim()}>
              {inviting ? t("members.invitingEllipsis") : t("members.invite")}
            </Button>
          </div>
          {error && <p className="type-body text-danger">{error}</p>}
        </Card>
      </section>

      {data.invitations.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 type-headline">{t("members.pendingInvitesHeading")}</h2>
          <div className="flex flex-col gap-1.5">
            {data.invitations.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between rounded-[9px] border border-border bg-surface px-3 py-2 text-[12.5px]">
                <span>
                  {inv.email} <span className="text-text-3">· {inv.role}</span>
                </span>
                <button onClick={() => cancel(inv.id)} className="rounded-[7px] px-1.5 py-0.5 text-[11px] text-text-3 hover:bg-danger-soft hover:text-danger">
                  {t("members.cancel")}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 type-headline">{t("members.currentMembersHeading")}</h2>
        <div className="flex flex-col gap-1.5">
          {data.members.map((m) => (
            <div key={m.id} className="flex items-center gap-2.5 rounded-[9px] border border-border bg-surface px-3 py-2 text-[12.5px]">
              <Avatar initials={initialsOf(m.name)} size={22} />
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              <span className="text-text-3">{m.email}</span>
              <Badge tone="neutral">{m.role}</Badge>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
