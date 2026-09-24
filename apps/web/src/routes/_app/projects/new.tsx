import { createFileRoute, Link, useLoaderData, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { FolderKanban } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { Card } from "@kompast/ui/Card";
import { EmptyState } from "@kompast/ui/EmptyState";
import { FormField, NativeSelect, TextField } from "@kompast/ui/Input";
import { PageContainer } from "@kompast/ui/PageContainer";
import { PageHeader } from "@kompast/ui/PageHeader";
import { useTranslation } from "@kompast/i18n";
import { createProjectFn } from "@/lib/server-fns/projects";
import { ProjectIcon } from "@/components/shell/ProjectIcon";
import { usePageChrome } from "@/components/shell/WorkbenchContext";

export const Route = createFileRoute("/_app/projects/new")({
  validateSearch: (search: Record<string, unknown>): { teamId?: string } => ({
    teamId: typeof search.teamId === "string" ? search.teamId : undefined,
  }),
  component: NewProjectPage,
});

/** Suggests a key from the name the way Jira does: initials of each word, else the first letters. */
function suggestKey(name: string) {
  const words = name.trim().toUpperCase().replace(/[^A-Z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const key = words.length > 1 ? words.map((w) => w[0]).join("") : words[0]!.slice(0, 4);
  return key.slice(0, 10);
}

function NewProjectPage() {
  const { t } = useTranslation("projects");
  const shell = useLoaderData({ from: "/_app" });
  const { teamId: preselectedTeamId } = Route.useSearch();
  const router = useRouter();

  const eligibleTeams = shell.teams.filter((tm) => shell.isSuperAdmin || tm.myRole === "admin");

  const [teamId, setTeamId] = useState(
    (preselectedTeamId && eligibleTeams.some((tm) => tm.id === preselectedTeamId) ? preselectedTeamId : undefined) ?? eligibleTeams[0]?.id ?? "",
  );
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  usePageChrome({ crumbs: [{ label: t("pageTitle"), icon: <FolderKanban size={15} strokeWidth={1.75} className="text-text-3" /> }] }, [t]);

  async function create() {
    const k = key.trim().toUpperCase();
    if (!k || !name.trim() || !teamId) return;
    setCreating(true);
    setError(null);
    try {
      await createProjectFn({ data: { teamId, key: k, name: name.trim() } });
      await router.invalidate();
      await router.navigate({ to: "/projects/$teamId/$projectKey", params: { teamId, projectKey: k } });
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
      <PageContainer width="narrow">
        <EmptyState
          icon={<FolderKanban size={18} />}
          title={t("noEligibleTeamTitle")}
          description={shell.isSuperAdmin ? t("noEligibleTeamSuperAdmin") : t("noEligibleTeamMember")}
          action={
            shell.isSuperAdmin && (
              <Link to="/teams/new" className="inline-flex h-8 items-center rounded-[6px] bg-accent px-3 text-[14px] font-medium text-white hover:bg-accent-hover">
                {t("createTeam")}
              </Link>
            )
          }
        />
      </PageContainer>
    );
  }

  const shownKey = key || "KEY";

  return (
    <PageContainer width="narrow">
      <PageHeader title={t("pageTitle")} subtitle={t("pageSubtitle")} />
      <Card>
        <form
          className="flex flex-col gap-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <FormField label={t("teamLabel")} htmlFor="project-team">
            <NativeSelect id="project-team" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              {eligibleTeams.map((tm) => (
                <option key={tm.id} value={tm.id}>
                  {tm.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label={t("nameLabel")} htmlFor="project-name" required>
            <TextField
              id="project-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!keyTouched) setKey(suggestKey(e.target.value));
              }}
              placeholder={t("namePlaceholder")}
              autoFocus
            />
          </FormField>
          <FormField label={t("keyLabel")} htmlFor="project-key" hint={t("keyHint", { key: shownKey })} error={error ?? undefined} required>
            <div className="flex items-center gap-2.5">
              <ProjectIcon projectKey={shownKey} size={32} />
              <TextField
                id="project-key"
                value={key}
                onChange={(e) => {
                  setKeyTouched(true);
                  setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
                }}
                placeholder={t("keyPlaceholder")}
                maxLength={10}
                aria-invalid={!!error}
                className="font-mono"
              />
            </div>
          </FormField>
          <div>
            <Button type="submit" variant="primary" disabled={creating || !key.trim() || !name.trim()}>
              {creating ? t("creatingEllipsis") : t("createProject")}
            </Button>
          </div>
        </form>
      </Card>
    </PageContainer>
  );
}
