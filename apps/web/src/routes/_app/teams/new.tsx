import { createFileRoute, redirect, useLoaderData, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { Card } from "@kompast/ui/Card";
import { PageContainer } from "@kompast/ui/PageContainer";
import { PageHeader } from "@kompast/ui/PageHeader";
import { useTranslation } from "@kompast/i18n";
import { createTeamFn } from "@/lib/server-fns/teams";

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

  // Sidebar already hides the "+ team" affordance for non-super-admins —
  // someone can still type the URL directly. createTeamFn re-checks this
  // server-side regardless of what happens here.
  if (!shell.isSuperAdmin) {
    throw redirect({ to: "/" });
  }

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createTeamFn({ data: { name: name.trim() } });
      await router.invalidate();
      await router.navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("createTeamFailed"));
    } finally {
      setCreating(false);
    }
  }

  return (
    <PageContainer width="narrow">
      <PageHeader title={t("newTeamPageTitle")} subtitle={t("newTeamPageSubtitle")} />

      <Card className="flex flex-col gap-3 p-4">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder={t("teamNamePlaceholder")}
          autoFocus
          className="min-w-0 flex-1 rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
        />
        {error && <p className="type-body text-danger">{error}</p>}
        <Button variant="primary" onClick={create} disabled={creating || !name.trim()} className="self-start">
          {creating ? t("creatingEllipsis") : t("createTeam")}
        </Button>
      </Card>
    </PageContainer>
  );
}
