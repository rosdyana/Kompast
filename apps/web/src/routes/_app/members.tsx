import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { Card } from "@kompast/ui/Card";
import { Avatar } from "@kompast/ui/Avatar";
import { listMembersFn, inviteMemberFn, cancelInvitationFn } from "@/lib/server-fns/members";

export const Route = createFileRoute("/_app/members")({
  loader: async () => {
    try {
      return await listMembersFn();
    } catch {
      // The sidebar already hides this link for non-admins — someone can still type the URL directly.
      throw redirect({ to: "/" });
    }
  },
  component: MembersPage,
});

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function MembersPage() {
  const data = Route.useLoaderData();
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
      setError(err instanceof Error ? err.message : "Gagal mengirim undangan");
    } finally {
      setInviting(false);
    }
  }

  async function cancel(invitationId: string) {
    await cancelInvitationFn({ data: invitationId });
    await router.invalidate();
  }

  return (
    <div className="mx-auto max-w-[640px] px-8 pb-16 pt-9">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Anggota workspace</h1>
      <p className="mb-8 text-sm text-text-2">Undang orang baru dan kelola undangan yang masih menunggu.</p>

      <section className="mb-8">
        <h2 className="mb-3 text-[13px] font-semibold">Undang anggota baru</h2>
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex gap-2">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && invite()}
              placeholder="nama@perusahaan.com"
              className="min-w-0 flex-1 rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as typeof role)}
              className="rounded-[7px] border border-border-2 bg-surface px-2.5 py-2 text-[13px] outline-none"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <Button variant="primary" onClick={invite} disabled={inviting || !email.trim()}>
              {inviting ? "Mengirim…" : "Undang"}
            </Button>
          </div>
          {error && <p className="text-[12px] text-red-500">{error}</p>}
        </Card>
      </section>

      {data.invitations.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-[13px] font-semibold">Undangan menunggu</h2>
          <div className="flex flex-col gap-1.5">
            {data.invitations.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 text-[12.5px]">
                <span>
                  {inv.email} <span className="text-text-3">· {inv.role}</span>
                </span>
                <button onClick={() => cancel(inv.id)} className="rounded px-1.5 py-0.5 text-[11px] text-text-3 hover:bg-danger-soft hover:text-danger">
                  Batalkan
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-[13px] font-semibold">Anggota saat ini</h2>
        <div className="flex flex-col gap-1.5">
          {data.members.map((m) => (
            <div key={m.id} className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-[12.5px]">
              <Avatar initials={initialsOf(m.name)} size={22} />
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              <span className="text-text-3">{m.email}</span>
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-2">{m.role}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
