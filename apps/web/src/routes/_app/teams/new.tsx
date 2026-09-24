import { createFileRoute, Link, useLoaderData, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { UsersRound } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { Card } from "@kompast/ui/Card";
import { EmptyState } from "@kompast/ui/EmptyState";
import { FormField, TextField } from "@kompast/ui/Input";
import { PageContainer } from "@kompast/ui/PageContainer";
import { PageHeader } from "@kompast/ui/PageHeader";
import { useTranslation } from "@kompast/i18n";
import { createTeamFn } from "@/lib/server-fns/teams";
import { usePageChrome } from "@/components/shell/WorkbenchContext";

export const Route = createFileRoute("/_app/teams/new")({
  component: NewTeamPage,
});

function NewTeamPage() {
  const { t } = useTranslation("teams");
  const shell = useLoaderData({ from: "/_app" });
  const router = useRouter();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  usePageChrome(
    {
      crumbs: [
        { label: t("settings"), link: { to: "/settings", search: { tab: "teams" } } },
        { label: t("newTeamPageTitle"), icon: <UsersRound size={15} strokeWidth={1.75} className="text-text-3" /> },
      ],
    },
    [t],
  );

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const team = await createTeamFn({ data: { name: name.trim() } });
      await router.invalidate();
      // A new team has no projects yet — go straight to creating its first one.
      await router.navigate({ to: "/projects/new", search: { teamId: team.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("createTeamFailed"));
    } finally {
      setCreating(false);
    }
  }

  // Sidebar already hides the "+ team" affordance for non-super-admins —
  // someone can still type the URL directly. createTeamFn re-checks this
  // server-side regardless of what happens here. (Rendering this state
  // instead of throwing redirect() from a component, which only works in
  // loaders/beforeLoad.)
  if (!shell.isSuperAdmin) {
    return (
      <PageContainer width="narrow">
        <EmptyState
          icon={<UsersRound size={18} />}
          title={t("noAccessTitle")}
          action={
            <Link to="/" className="inline-flex h-8 items-center rounded-[6px] border border-border-2 bg-surface px-3 text-[14px] font-medium hover:bg-surface-2">
              {t("goHome")}
            </Link>
          }
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer width="narrow">
      <PageHeader title={t("newTeamPageTitle")} subtitle={t("newTeamPageSubtitle")} />
      <Card>
        <form
          className="flex flex-col gap-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <FormField label={t("nameLabel")} htmlFor="team-name" error={error ?? undefined}>
            <TextField id="team-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("teamNamePlaceholder")} autoFocus aria-invalid={!!error} />
          </FormField>
          <div>
            <Button type="submit" variant="primary" disabled={creating || !name.trim()}>
              {creating ? t("creatingEllipsis") : t("createTeam")}
            </Button>
          </div>
        </form>
      </Card>
    </PageContainer>
  );
}
