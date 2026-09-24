import { useClientNow } from "@/lib/use-client-now";
import type { ReactNode } from "react";
import { createFileRoute, Link, useLoaderData } from "@tanstack/react-router";
import { FileText, FolderKanban, Home as HomeIcon, Inbox, Plus } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { EmptyState } from "@kompast/ui/EmptyState";
import { IssueTypeIcon } from "@kompast/ui/IssueTypeIcon";
import { Lozenge, type StatusCategory } from "@kompast/ui/Lozenge";
import { PageContainer } from "@kompast/ui/PageContainer";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import { getHomeSummaryFn } from "@/lib/server-fns/home";
import { cn } from "@/lib/cn";
import { PageIcon } from "@/components/docs/DocsTree";
import { ProjectIcon } from "@/components/shell/ProjectIcon";
import { usePageChrome, useWorkbench } from "@/components/shell/WorkbenchContext";

export const Route = createFileRoute("/_app/")({
  loader: () => getHomeSummaryFn(),
  component: HomePage,
});

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };
const DAY = 86_400_000;

type Summary = Awaited<ReturnType<typeof getHomeSummaryFn>>;
type ShellPage = { id: string; title: string; icon: string | null; parentPageId: string | null; updatedAt?: string | Date };

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function relative(date: Date, locale: string) {
  const diff = (date.getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <h2 className="type-headline">{children}</h2>
      {action}
    </div>
  );
}

function HomePage() {
  const data = Route.useLoaderData();
  const shell = useLoaderData({ from: "/_app" });
  const { t, i18n } = useTranslation("home");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const { openCreateIssue, createPage } = useWorkbench();

  usePageChrome({ crumbs: [{ label: t("home"), icon: <HomeIcon size={15} strokeWidth={1.75} className="text-text-3" /> }] }, [t]);

  const now = useClientNow();
  const firstName = shell.user.name.trim().split(/\s+/)[0] ?? shell.user.name;
  const hour = now?.getHours();
  const greeting =
    hour === undefined
      ? t("greetingNeutral", { name: firstName })
      : hour < 12
        ? t("greetingMorning", { name: firstName })
        : hour < 18
          ? t("greetingAfternoon", { name: firstName })
          : t("greetingEvening", { name: firstName });

  const canCreateProject = data.isSuperAdmin || data.adminTeamIds.length > 0;
  const pages = [...(shell.pages as ShellPage[])]
    .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime())
    .slice(0, 6);
  const sprintProject = data.projects.find((p) => p.activeSprint);

  return (
    <PageContainer width="dense">
      <header className="mb-8">
        <h1 className="type-display">{greeting}</h1>
        <p className="mt-1 type-body text-text-2">{t("subtitle")}</p>
      </header>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section>
          <SectionTitle
            action={
              data.projects.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => openCreateIssue()}>
                  <Plus size={14} />
                  {t("createIssue")}
                </Button>
              )
            }
          >
            {t("assignedToMe")}
          </SectionTitle>
          {data.myIssues.length === 0 ? (
            <EmptyState
              icon={<Inbox size={18} />}
              title={t("assignedEmpty")}
              description={t("assignedEmptyHint")}
              action={
                data.projects.length > 0 && (
                  <Button size="sm" variant="primary" onClick={() => openCreateIssue()}>
                    {t("createIssue")}
                  </Button>
                )
              }
            />
          ) : (
            <div className="overflow-hidden rounded-[10px] border border-border bg-surface">
              {data.myIssues.map((issue) => (
                <AssignedRow key={issue.id} issue={issue} intlLocale={intlLocale} />
              ))}
            </div>
          )}
        </section>

        <div className="flex flex-col gap-8">
          {sprintProject?.activeSprint && <SprintSnapshot project={sprintProject} intlLocale={intlLocale} />}

          <section>
            <SectionTitle
              action={
                <Button size="sm" variant="ghost" onClick={() => createPage()}>
                  <Plus size={14} />
                  {t("newPage")}
                </Button>
              }
            >
              {t("recentPages")}
            </SectionTitle>
            {pages.length === 0 ? (
              <EmptyState icon={<FileText size={18} />} title={t("recentEmpty")} description={t("recentEmptyHint")} />
            ) : (
              <div className="flex flex-col gap-px">
                {pages.map((p) => (
                  <Link
                    key={p.id}
                    to="/docs/$pageId"
                    params={{ pageId: p.id }}
                    className="flex h-10 items-center gap-2.5 rounded-[6px] px-2 hover:bg-surface-3"
                  >
                    <PageIcon icon={p.icon} size={18} />
                    <span className={cn("min-w-0 flex-1 truncate text-[14px]", !p.title && "text-text-3")}>{p.title || t("untitled")}</span>
                    {p.updatedAt && (
                      <span className="flex-none text-[12px] text-text-3">{t("edited", { time: relative(new Date(p.updatedAt), intlLocale) })}</span>
                    )}
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      <section className="mt-10">
        <SectionTitle
          action={
            canCreateProject && (
              <Link to="/projects/new" className="inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-[13px] font-medium text-text-2 hover:bg-surface-3 hover:text-text">
                <Plus size={14} />
                {t("createProject")}
              </Link>
            )
          }
        >
          {t("projects")}
        </SectionTitle>
        {data.projects.length === 0 ? (
          <EmptyState
            icon={<FolderKanban size={18} />}
            title={t("projectsEmpty")}
            description={canCreateProject ? t("projectsEmptyHint") : t("projectsEmptyMember")}
            action={
              canCreateProject && (
                <Link to="/projects/new" className="inline-flex h-8 items-center rounded-[6px] bg-accent px-3 text-[14px] font-medium text-white hover:bg-accent-hover">
                  {t("createProject")}
                </Link>
              )
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data.projects.map((p) => (
              <ProjectTile key={p.id} project={p} />
            ))}
          </div>
        )}
      </section>
    </PageContainer>
  );
}

function AssignedRow({ issue, intlLocale }: { issue: Summary["myIssues"][number]; intlLocale: string }) {
  const { t } = useTranslation("home");
  const due = issue.dueDate ? new Date(issue.dueDate) : null;
  const today = startOfDay(new Date());
  const dueDay = due ? startOfDay(due) : null;
  const dueLabel =
    dueDay === null ? null : dueDay < today ? t("overdue") : dueDay === today ? t("dueToday") : t("dueOn", { date: due!.toLocaleDateString(intlLocale, { day: "numeric", month: "short" }) });

  return (
    <Link
      to="/issues/$teamId/$projectKey/$issueKeySeq"
      params={{ teamId: issue.teamId ?? "none", projectKey: issue.projectKey, issueKeySeq: String(issue.keySeq) }}
      className="flex min-h-11 items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-surface-2"
    >
      <IssueTypeIcon type={{ name: issue.typeName, color: issue.typeColor, hierarchyLevel: issue.typeHierarchyLevel, isSubtask: issue.typeIsSubtask }} size={16} />
      <span className="type-key w-[72px] flex-none truncate text-text-3">
        {issue.projectKey}-{issue.keySeq}
      </span>
      <span className="min-w-0 flex-1 truncate text-[14px] text-text">{issue.title}</span>
      {dueLabel && (
        <span className={cn("hidden flex-none text-[12.5px] sm:inline", dueDay! < today ? "font-medium text-danger" : dueDay === today ? "text-amber" : "text-text-3")}>
          {dueLabel}
        </span>
      )}
      <Lozenge color={issue.statusColor} category={issue.statusCategory as StatusCategory} className="max-w-[120px]">
        {issue.statusName}
      </Lozenge>
    </Link>
  );
}

function SprintSnapshot({ project, intlLocale }: { project: Summary["projects"][number]; intlLocale: string }) {
  const { t } = useTranslation("home");
  const s = project.activeSprint!;
  const total = Math.max(1, s.total);
  const daysLeft = s.endAt ? Math.ceil((startOfDay(new Date(s.endAt)) - startOfDay(new Date())) / DAY) : null;
  const segments = [
    { key: "done", n: s.done, color: "var(--green)", label: t("done") },
    { key: "inProgress", n: s.inProgress, color: "var(--accent)", label: t("inProgress") },
    { key: "todo", n: s.todo, color: "var(--border2)", label: t("todo") },
  ];
  return (
    <section>
      <SectionTitle
        action={
          <Link
            to="/projects/$teamId/$projectKey"
            params={{ teamId: project.teamId ?? "none", projectKey: project.key }}
            search={{ tab: "board" }}
            className="text-[13px] font-medium text-accent-text hover:underline"
          >
            {t("openBoard")}
          </Link>
        }
      >
        {t("activeSprint")}
      </SectionTitle>
      <div className="rounded-[10px] border border-border bg-surface p-4">
        <div className="mb-3 flex items-center gap-2.5">
          <ProjectIcon projectKey={project.key} size={22} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-medium">{s.name}</p>
            <p className="truncate text-[12.5px] text-text-3">
              {project.name}
              {s.startAt && s.endAt && ` · ${new Date(s.startAt).toLocaleDateString(intlLocale, { day: "numeric", month: "short" })} – ${new Date(s.endAt).toLocaleDateString(intlLocale, { day: "numeric", month: "short" })}`}
            </p>
          </div>
          {daysLeft !== null && (
            <span className={cn("flex-none text-[12.5px]", daysLeft < 0 ? "text-danger" : "text-text-2")}>
              {daysLeft < 0 ? t("sprintOverdue") : t("sprintDaysLeft", { count: daysLeft })}
            </span>
          )}
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-surface-3" role="img" aria-label={t("issuesDone", { done: s.done, total: s.total })}>
          {segments.map((seg) => seg.n > 0 && <span key={seg.key} style={{ width: `${(seg.n / total) * 100}%`, background: seg.color }} />)}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-text-2">
          {segments.map((seg) => (
            <span key={seg.key} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: seg.color }} />
              {seg.label}
              <span className="font-medium tabular-nums text-text">{seg.n}</span>
            </span>
          ))}
          {s.points > 0 && <span className="ml-auto text-text-3">{t("pointsDone", { done: s.donePoints, total: s.points })}</span>}
        </div>
      </div>
    </section>
  );
}

function ProjectTile({ project }: { project: Summary["projects"][number] }) {
  const { t } = useTranslation("home");
  const s = project.activeSprint;
  const pct = s && s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
  return (
    <Link
      to="/projects/$teamId/$projectKey"
      params={{ teamId: project.teamId ?? "none", projectKey: project.key }}
      search={{ tab: "backlog" }}
      className="group flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-4 transition-[border-color,box-shadow] hover:border-border-2 hover:shadow-card"
    >
      <div className="flex items-center gap-2.5">
        <ProjectIcon projectKey={project.key} size={28} />
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-text">{project.name}</p>
          <p className="type-key text-text-3">{project.key}</p>
        </div>
      </div>
      <div className="text-[12.5px] text-text-2">
        <p>{t("openIssues", { count: project.openIssueCount })}</p>
        {s ? (
          <div className="mt-2">
            <div className="mb-1 flex justify-between gap-2">
              <span className="truncate">{s.name}</span>
              <span className="tabular-nums text-text-3">{pct}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-green" style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : (
          <p className="mt-2 text-text-3">{t("noActiveSprint")}</p>
        )}
      </div>
    </Link>
  );
}
