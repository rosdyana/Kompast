import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Card } from "@kompast/ui/Card";
import { Button } from "@kompast/ui/Button";
import { getTeamManagementFn, addTeamMemberFn, removeTeamMemberFn, setTeamMemberRoleFn } from "@/lib/server-fns/teams";

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
  const data = Route.useLoaderData();
  const { teamId } = Route.useParams();
  const router = useRouter();
  const [candidateUserId, setCandidateUserId] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adminCount = data.members.filter((m) => m.role === "admin").length;

  async function addMember() {
    if (!candidateUserId) return;
    setAdding(true);
    setError(null);
    try {
      await addTeamMemberFn({ data: { teamId, userId: candidateUserId } });
      setCandidateUserId("");
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menambah anggota");
    } finally {
      setAdding(false);
    }
  }

  async function remove(userId: string) {
    await removeTeamMemberFn({ data: { teamId, userId } });
    await router.invalidate();
  }

  async function setRole(userId: string, role: "admin" | "member") {
    await setTeamMemberRoleFn({ data: { teamId, userId, role } });
    await router.invalidate();
  }

  return (
    <div className="mx-auto max-w-[640px] px-8 pb-16 pt-9">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Kelola tim</h1>
      <p className="mb-8 text-sm text-text-2">Tambah atau hapus anggota, dan atur siapa yang menjadi admin tim ini.</p>

      <section className="mb-8">
        <h2 className="mb-3 text-[13px] font-semibold">Tambah anggota</h2>
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex gap-2">
            <select
              value={candidateUserId}
              onChange={(e) => setCandidateUserId(e.target.value)}
              className="min-w-0 flex-1 rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none"
            >
              <option value="">Pilih anggota workspace…</option>
              {data.candidates.map((c) => (
                <option key={c.userId} value={c.userId}>
                  {c.name} ({c.email})
                </option>
              ))}
            </select>
            <Button variant="primary" onClick={addMember} disabled={adding || !candidateUserId}>
              {adding ? "Menambah…" : "Tambah"}
            </Button>
          </div>
          {data.candidates.length === 0 && (
            <p className="text-[12px] text-text-3">Semua anggota workspace sudah ada di tim ini.</p>
          )}
          {error && <p className="text-[12px] text-danger">{error}</p>}
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-[13px] font-semibold">Anggota tim</h2>
        <div className="flex flex-col gap-1.5">
          {data.members.map((m) => (
            <div key={m.id} className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-[12.5px]">
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              <span className="text-text-3">{m.email}</span>
              <select
                value={m.role}
                onChange={(e) => setRole(m.userId, e.target.value as "admin" | "member")}
                disabled={m.role === "admin" && adminCount <= 1}
                title={m.role === "admin" && adminCount <= 1 ? "Tim ini butuh setidaknya satu admin" : undefined}
                className="rounded-[7px] border border-border-2 bg-surface px-2 py-1 text-[12px] outline-none"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <button
                onClick={() => remove(m.userId)}
                disabled={m.role === "admin" && adminCount <= 1}
                title={m.role === "admin" && adminCount <= 1 ? "Tim ini butuh setidaknya satu admin" : undefined}
                className="rounded px-1.5 py-0.5 text-[11px] text-text-3 hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
              >
                Hapus
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
