import { useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { Button } from "@kompast/ui/Button";
import { Card } from "@kompast/ui/Card";
import { Badge } from "@kompast/ui/Badge";
import { useTranslation } from "@kompast/i18n";
import { transferSuperAdminFn, type listTeamsFn } from "@/lib/server-fns/teams";
import type { listMembersFn } from "@/lib/server-fns/members";

export function TeamsTab({
  teams,
  members,
}: {
  teams: Awaited<ReturnType<typeof listTeamsFn>>;
  members: Awaited<ReturnType<typeof listMembersFn>>["members"];
}) {
  const { t } = useTranslation("teams");

  return (
    <div>
      <div className="mb-4 flex items-baseline justify-between">
        <p className="type-body text-text-2">{t("overviewSubtitle")}</p>
        <Link to="/teams/new" className="type-body text-accent">
          {t("newTeamLink")}
        </Link>
      </div>

      <Card className="mb-8 overflow-hidden">
        {teams.length === 0 && <p className="p-4 type-body text-text-3">{t("noTeamsYet")}</p>}
        {teams.map((team) => (
          <Link
            key={team.id}
            to="/teams/$teamId"
            params={{ teamId: team.id }}
            className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0 hover:bg-surface-2"
          >
            <span className="min-w-0 flex-1 truncate type-body font-medium">{team.name}</span>
            <span className="type-label text-text-3">{t("teamMemberCount", { count: team.memberCount })}</span>
            <span className="type-label text-text-3">{t("teamProjectCount", { count: team.projectCount })}</span>
            {team.myRole === "admin" && <Badge tone="neutral">{t("adminBadge")}</Badge>}
          </Link>
        ))}
      </Card>

      <TransferSuperAdmin members={members} />
    </div>
  );
}

function TransferSuperAdmin({ members }: { members: Awaited<ReturnType<typeof listMembersFn>>["members"] }) {
  const { t } = useTranslation("teams");
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
      setError(err instanceof Error ? err.message : t("transferFailed"));
    } finally {
      setTransferring(false);
    }
  }

  return (
    <section>
      <h2 className="mb-3 type-headline">{t("transferHeading")}</h2>
      <p className="mb-3 type-body text-text-2">{t("transferSubtitle")}</p>
      <Card className="flex items-center gap-2 p-4">
        <select
          value={newHolderUserId}
          onChange={(e) => setNewHolderUserId(e.target.value)}
          className="kp-select min-w-0 flex-1 rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[12.5px] outline-none"
        >
          <option value="">{t("transferMemberSelectPlaceholder")}</option>
          {members.map((m) => (
            <option key={m.id} value={m.userId}>
              {m.name} ({m.email})
            </option>
          ))}
        </select>
        <Button variant="outline" onClick={transfer} disabled={transferring || !newHolderUserId}>
          {transferring ? t("transferringEllipsis") : t("transfer")}
        </Button>
      </Card>
      {error && <p className="mt-2 type-body text-danger">{error}</p>}
    </section>
  );
}
