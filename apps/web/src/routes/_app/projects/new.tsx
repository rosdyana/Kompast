import { createFileRoute, Link, useLoaderData, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { Card } from "@kompast/ui/Card";
import { useTranslation } from "@kompast/i18n";
import { createProjectFn } from "@/lib/server-fns/projects";

export const Route = createFileRoute("/_app/projects/new")({
  validateSearch: (search: Record<string, unknown>): { teamId?: string } => ({
    teamId: typeof search.teamId === "string" ? search.teamId : undefined,
  }),
  component: NewProjectPage,
});

function NewProjectPage() {
  const { t } = useTranslation("projects");
  const shell = useLoaderData({ from: "/_app" });
  const { teamId: preselectedTeamId } = Route.useSearch();
  const router = useRouter();

  const eligibleTeams = shell.teams.filter((tm) => shell.isSuperAdmin || tm.myRole === "admin");

  const [teamId, setTeamId] = useState(preselectedTeamId ?? eligibleTeams[0]?.id ?? "");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!key.trim() || !name.trim() || !teamId) return;
    setCreating(true);
    setError(null);
    try {
      await createProjectFn({ data: { teamId, key: key.trim(), name: name.trim() } });
      await router.invalidate();
      await router.navigate({ to: "/projects/$projectKey", params: { projectKey: key.trim().toUpperCase() } });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("createFailed"));
    } finally {
      setCreating(false);
    }
  }

  // Sidebar/home only ever show a "+ project" affordance when at least one
  // eligible team exists — someone can still type the URL directly.
  // createProjectFn re-checks requireTeamAdmin server-side regardless.
  if (eligibleTeams.length === 0) {
    return (
      <div className="mx-auto max-w-[520px] px-8 pb-16 pt-9">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">{t("pageTitle")}</h1>
        <Card className="flex flex-col items-start gap-3 p-4">
          <h2 className="text-[15px] font-semibold">{t("noEligibleTeamTitle")}</h2>
          <p className="text-sm text-text-2">
            {shell.isSuperAdmin ? t("noEligibleTeamSuperAdmin") : t("noEligibleTeamMember")}
          </p>
          {shell.isSuperAdmin && (
            <Link
              to="/teams/new"
              className="inline-flex items-center justify-center gap-2 rounded-[7px] bg-accent px-3 py-1.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
            >
              {t("createTeam")}
            </Link>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[520px] px-8 pb-16 pt-9">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">{t("pageTitle")}</h1>
      <p className="mb-8 text-sm text-text-2">{t("pageSubtitle")}</p>

      <Card className="flex flex-col gap-3 p-4">
        <select
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          className="rounded-[7px] border border-border-2 bg-surface px-2.5 py-2 text-[13px] outline-none"
        >
          {eligibleTeams.map((tm) => (
            <option key={tm.id} value={tm.id}>
              {tm.name}
            </option>
          ))}
        </select>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("namePlaceholder")}
          autoFocus
          className="min-w-0 flex-1 rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none"
        />
        <input
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder={t("keyPlaceholder")}
          maxLength={10}
          className="min-w-0 flex-1 rounded-[7px] border border-border-2 bg-surface px-3 py-2 font-mono text-[13px] outline-none"
        />
        {error && <p className="text-[12px] text-danger">{error}</p>}
        <Button variant="primary" onClick={create} disabled={creating || !key.trim() || !name.trim()} className="self-start">
          {creating ? t("creatingEllipsis") : t("createProject")}
        </Button>
      </Card>
    </div>
  );
}
