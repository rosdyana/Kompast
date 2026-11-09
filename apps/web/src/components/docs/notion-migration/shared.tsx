import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "@kompast/ui/Badge";
import { FormField, NativeSelect, TextField } from "@kompast/ui/Input";
import { useTranslation } from "@kompast/i18n";
import type { NotionTargetChoice, TreeNodeLike } from "@/lib/notion-migration-tree";
import type { getNotionMigrationFn } from "@/lib/server-fns/notion-migration";

/** One migration as getNotionMigrationFn returns it (no resume cursor). */
export type MigrationView = NonNullable<Awaited<ReturnType<typeof getNotionMigrationFn>>>;

/** The discovery snapshot the worker stores in notion_migration.discovery (packages/import NotionDiscovery). */
export interface DiscoveryView {
  workspaceName: string;
  nodes: TreeNodeLike[];
  truncated: boolean;
}

/** The roots the user saved in notion_migration.selection. */
export interface SavedSelection {
  roots: { notionId: string; title: string; target: NotionTargetChoice }[];
}

export const NOTION_INTEGRATIONS_URL = "https://www.notion.so/profile/integrations";

export interface TeamOption {
  id: string;
  name: string;
}

/** The message a server function's error carries, or the fallback. */
export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** A destination as one select value: "workspace", "private", or "team:<id>". */
export function targetValue(target: NotionTargetChoice): string {
  if (target === "workspace" || target === "private") return target;
  return `team:${target.team}`;
}

export function targetFromValue(value: string): NotionTargetChoice {
  if (value === "workspace" || value === "private") return value;
  return { team: value.replace(/^team:/, "") };
}

export type MigrationState = "draft" | "discovering" | "ready" | "running" | "done" | "failed";

const STATE_TONE: Record<MigrationState, BadgeTone> = {
  draft: "neutral",
  discovering: "accent",
  ready: "indigo",
  running: "accent",
  done: "green",
  failed: "danger",
};

export function StateBadge({ state }: { state: MigrationState }) {
  const { t } = useTranslation("docs");
  return <Badge tone={STATE_TONE[state]}>{t(`notionMigration.states.${state}`)}</Badge>;
}

/**
 * A native select for a destination. Workspace is offered only when the
 * caller may import there; teams are the caller's teams (not locked). A saved
 * team the caller no longer lists still shows, under the generic team label.
 */
export function TargetSelect({
  value,
  onChange,
  canImportToWorkspace,
  teams,
  disabled,
  ariaLabel,
  className,
}: {
  value: NotionTargetChoice;
  onChange: (target: NotionTargetChoice) => void;
  canImportToWorkspace: boolean;
  teams: TeamOption[];
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  const { t } = useTranslation("docs");
  const current = targetValue(value);
  const teamKnown = typeof value === "object" && teams.some((team) => team.id === value.team);
  return (
    <NativeSelect
      aria-label={ariaLabel}
      value={current}
      disabled={disabled}
      onChange={(e) => onChange(targetFromValue(e.target.value))}
      className={className ?? "h-7 min-w-0 max-w-[200px] py-0 text-[13px]"}
    >
      {canImportToWorkspace && <option value="workspace">{t("notionImport.workspace")}</option>}
      <option value="private">{t("notionImport.private")}</option>
      {teams.map((team) => (
        <option key={team.id} value={`team:${team.id}`}>
          {team.name}
        </option>
      ))}
      {typeof value === "object" && !teamKnown && <option value={current}>{t("notionImport.team")}</option>}
    </NativeSelect>
  );
}

/** A human label for a destination, for the review list. */
export function targetLabel(value: NotionTargetChoice, teams: TeamOption[], t: (key: "notionImport.workspace" | "notionImport.private" | "notionImport.team") => string): string {
  if (value === "workspace") return t("notionImport.workspace");
  if (value === "private") return t("notionImport.private");
  return teams.find((team) => team.id === value.team)?.name ?? t("notionImport.team");
}

/** The Notion integration secret. Password type, never echoed back. */
export function TokenField({ id, value, onChange, label, hint }: { id: string; value: string; onChange: (v: string) => void; label: string; hint?: ReactNode }) {
  return (
    <FormField label={label} htmlFor={id} required hint={hint}>
      <TextField id={id} type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} />
    </FormField>
  );
}
