import { useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { Button } from "@kompast/ui/Button";
import { Card } from "@kompast/ui/Card";
import { transferSuperAdminFn, type listTeamsFn } from "@/lib/server-fns/teams";
import type { listMembersFn } from "@/lib/server-fns/members";

export function TeamsTab({
  teams,
  members,
}: {
  teams: Awaited<ReturnType<typeof listTeamsFn>>;
  members: Awaited<ReturnType<typeof listMembersFn>>["members"];
}) {
  return (
    <div>
      <div className="mb-4 flex items-baseline justify-between">
        <p className="text-sm text-text-2">Setiap proyek dimiliki oleh sebuah tim. Kelola tim workspace ini di sini.</p>
        <Link to="/teams/new" className="text-[13px] text-accent">
          + Tim baru
        </Link>
      </div>

      <Card className="mb-8 overflow-hidden">
        {teams.length === 0 && <p className="p-4 text-sm text-text-3">Belum ada tim.</p>}
        {teams.map((team) => (
          <Link
            key={team.id}
            to="/teams/$teamId"
            params={{ teamId: team.id }}
            className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0 hover:bg-surface-2"
          >
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{team.name}</span>
            <span className="font-mono text-[11px] text-text-3">{team.memberCount} anggota</span>
            <span className="font-mono text-[11px] text-text-3">{team.projectCount} proyek</span>
            {team.myRole === "admin" && (
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-2">admin</span>
            )}
          </Link>
        ))}
      </Card>

      <TransferSuperAdmin members={members} />
    </div>
  );
}

function TransferSuperAdmin({ members }: { members: Awaited<ReturnType<typeof listMembersFn>>["members"] }) {
  const router = useRouter();
  const [newHolderUserId, setNewHolderUserId] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function transfer() {
    if (!newHolderUserId) return;
    setTransferring(true);
    setError(null);
    try {
      await transferSuperAdminFn({ data: { newHolderUserId } });
      setNewHolderUserId("");
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal memindahkan super admin");
    } finally {
      setTransferring(false);
    }
  }

  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold">Pindahkan super admin</h2>
      <p className="mb-3 text-[12px] text-text-2">
        Hanya ada satu super admin per workspace — orang ini bisa membuat tim baru dan mengelola tim mana pun. Memindahkan peran ini akan mencabutnya dari Anda.
      </p>
      <Card className="flex items-center gap-2 p-4">
        <select
          value={newHolderUserId}
          onChange={(e) => setNewHolderUserId(e.target.value)}
          className="min-w-0 flex-1 rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none"
        >
          <option value="">Pilih anggota…</option>
          {members.map((m) => (
            <option key={m.id} value={m.userId}>
              {m.name} ({m.email})
            </option>
          ))}
        </select>
        <Button variant="outline" onClick={transfer} disabled={transferring || !newHolderUserId}>
          {transferring ? "Memindahkan…" : "Pindahkan"}
        </Button>
      </Card>
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
    </section>
  );
}
