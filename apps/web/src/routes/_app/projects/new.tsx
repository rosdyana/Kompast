import { createFileRoute, redirect, useLoaderData, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { Card } from "@kompast/ui/Card";
import { createProjectFn } from "@/lib/server-fns/projects";

export const Route = createFileRoute("/_app/projects/new")({
  validateSearch: (search: Record<string, unknown>): { teamId?: string } => ({
    teamId: typeof search.teamId === "string" ? search.teamId : undefined,
  }),
  component: NewProjectPage,
});

function NewProjectPage() {
  const shell = useLoaderData({ from: "/_app" });
  const { teamId: preselectedTeamId } = Route.useSearch();
  const router = useRouter();

  const eligibleTeams = shell.teams.filter((t) => shell.isSuperAdmin || t.myRole === "admin");

  const [teamId, setTeamId] = useState(preselectedTeamId ?? eligibleTeams[0]?.id ?? "");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sidebar/home only ever show a "+ project" affordance when at least one
  // eligible team exists — someone can still type the URL directly.
  // createProjectFn re-checks requireTeamAdmin server-side regardless.
  if (eligibleTeams.length === 0) {
    throw redirect({ to: "/" });
  }

  async function create() {
    if (!key.trim() || !name.trim() || !teamId) return;
    setCreating(true);
    setError(null);
    try {
      await createProjectFn({ data: { teamId, key: key.trim(), name: name.trim() } });
      await router.invalidate();
      await router.navigate({ to: "/projects/$projectKey", params: { projectKey: key.trim().toUpperCase() } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal membuat proyek");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-[520px] px-8 pb-16 pt-9">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Proyek baru</h1>
      <p className="mb-8 text-sm text-text-2">Setiap proyek termasuk dalam sebuah tim, dan mendapat board kanban default.</p>

      <Card className="flex flex-col gap-3 p-4">
        <select
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          className="rounded-[7px] border border-border-2 bg-surface px-2.5 py-2 text-[13px] outline-none"
        >
          {eligibleTeams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nama proyek, mis. Kompast Core"
          autoFocus
          className="min-w-0 flex-1 rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none"
        />
        <input
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="Kode proyek, mis. KPT"
          maxLength={10}
          className="min-w-0 flex-1 rounded-[7px] border border-border-2 bg-surface px-3 py-2 font-mono text-[13px] outline-none"
        />
        {error && <p className="text-[12px] text-danger">{error}</p>}
        <Button variant="primary" onClick={create} disabled={creating || !key.trim() || !name.trim()} className="self-start">
          {creating ? "Membuat…" : "Buat proyek"}
        </Button>
      </Card>
    </div>
  );
}
