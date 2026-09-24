import { Link } from "@tanstack/react-router";
import { Avatar, UnassignedAvatar } from "@kompast/ui/Avatar";
import { IssueTypeIcon, type IssueTypeLike } from "@kompast/ui/IssueTypeIcon";
import { Lozenge, type StatusCategory } from "@kompast/ui/Lozenge";
import { PriorityIcon, type PriorityLike } from "@kompast/ui/PriorityIcon";
import { useTranslation } from "@kompast/i18n";

export interface ChildIssueRow {
  id: string;
  keySeq: number;
  title: string;
  typeId: string;
  statusId: string;
  priority: string;
  storyPoints: number | null;
  assigneeId: string | null;
  assigneeName: string | null;
}

interface StatusLike {
  id: string;
  name: string;
  color: string;
  category: StatusCategory;
}

/** Jira's "Child issues" panel: progress bar + compact linked rows. */
export function ChildIssues({
  children,
  typesById,
  statusesById,
  priorityByKey,
  teamId,
  projectKey,
}: {
  children: ChildIssueRow[];
  typesById: Map<string, IssueTypeLike & { id: string }>;
  statusesById: Map<string, StatusLike>;
  priorityByKey: Map<string, PriorityLike>;
  teamId: string;
  projectKey: string;
}) {
  const { t } = useTranslation("issue");
  if (children.length === 0) return <p className="text-[13.5px] text-text-3">{t("noChildIssues")}</p>;

  const done = children.filter((c) => statusesById.get(c.statusId)?.category === "done").length;
  const inProgress = children.filter((c) => statusesById.get(c.statusId)?.category === "in_progress").length;
  const pct = (n: number) => `${(n / children.length) * 100}%`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-surface-3" role="img" aria-label={t("childProgress", { done, total: children.length })}>
          <div className="h-full bg-green" style={{ width: pct(done) }} />
          <div className="h-full bg-accent" style={{ width: pct(inProgress) }} />
        </div>
        <span className="flex-none text-[12.5px] tabular-nums text-text-2">{t("childProgress", { done, total: children.length })}</span>
      </div>
      <div className="overflow-hidden rounded-[8px] border border-border">
        {children.map((c) => {
          const status = statusesById.get(c.statusId);
          return (
            <Link
              key={c.id}
              to="/issues/$teamId/$projectKey/$issueKeySeq"
              params={{ teamId, projectKey, issueKeySeq: String(c.keySeq) }}
              className="flex h-10 items-center gap-2.5 border-b border-border bg-surface px-3 text-[14px] last:border-b-0 hover:bg-surface-2"
            >
              <IssueTypeIcon type={typesById.get(c.typeId)} size={16} />
              <span className="type-key flex-none text-text-3">
                {projectKey}-{c.keySeq}
              </span>
              <span className="min-w-0 flex-1 truncate text-text">{c.title}</span>
              <PriorityIcon priority={priorityByKey.get(c.priority)} size={15} className="hidden sm:inline-flex" />
              {status && (
                <Lozenge color={status.color} className="hidden sm:inline-flex">
                  {status.name}
                </Lozenge>
              )}
              {c.assigneeName ? <Avatar name={c.assigneeName} size={22} /> : <UnassignedAvatar size={22} />}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
