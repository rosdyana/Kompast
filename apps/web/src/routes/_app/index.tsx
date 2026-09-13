import { createFileRoute, Link } from "@tanstack/react-router";
import { Card } from "@kompast/ui/Card";
import { PageContainer } from "@kompast/ui/PageContainer";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import { getHomeSummaryFn } from "@/lib/server-fns/home";

export const Route = createFileRoute("/_app/")({
  loader: () => getHomeSummaryFn(),
  component: HomePage,
});

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };

function HomePage() {
  const data = Route.useLoaderData();
  const { t, i18n } = useTranslation("home");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";

  return (
    <PageContainer width="dense">
      <h1 className="mb-[26px] type-display">{t("welcome")}</h1>

      <div className="grid grid-cols-[1.35fr_1fr] gap-6">
        <div>
          <div className="mb-2.5 flex items-baseline justify-between">
            <h2 className="type-headline">{t("activeBoard")}</h2>
            {data.activeBoard && (
              <Link
                to="/projects/$teamId/$projectKey"
                params={{ teamId: data.projects[0]!.teamId ?? "none", projectKey: data.projects[0]!.key }}
                className="type-body text-accent"
              >
                {t("openBoard")}
              </Link>
            )}
          </div>
          {data.activeBoard ? (
            <Card className="overflow-hidden">
              <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-3">
                <span className="type-body font-semibold">{data.activeBoard.name}</span>
              </div>
              <div className="overflow-x-auto">
                <div
                  className="grid gap-px bg-border"
                  style={{ gridTemplateColumns: `repeat(${data.activeBoard.columns.length}, minmax(140px, 1fr))` }}
                >
                  {data.activeBoard.columns.map((col) => (
                    <div key={col.id} className="bg-surface px-2.5 pb-3.5 pt-2.5">
                      <p className="mb-2 flex items-center gap-1.5 text-[10.5px] font-semibold text-text-2">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: col.color }} />
                        {col.name}
                        <span className="ml-auto type-label text-text-3">{col.issues.length}</span>
                      </p>
                      <div className="flex flex-col gap-1.5">
                        {col.issues.slice(0, 2).map((issue) => (
                          <Link
                            key={issue.id}
                            to="/issues/$teamId/$projectKey/$issueKeySeq"
                            params={{
                              teamId: data.activeBoard!.teamId ?? "none",
                              projectKey: data.activeBoard!.projectKey,
                              issueKeySeq: String(issue.keySeq),
                            }}
                            className="block rounded-[7px] border border-border bg-surface-2 px-2 py-1.5 hover:border-border-2"
                          >
                            <p className="mb-1 type-label text-text-3">#{issue.keySeq}</p>
                            <p className="truncate text-[11.5px] leading-tight">{issue.title}</p>
                          </Link>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          ) : (
            <Card className="p-4 type-body text-text-3">{t("noBoardYet")}</Card>
          )}

          <h2 className="mb-2.5 mt-[26px] type-headline">{t("projects")}</h2>
          <Card className="overflow-hidden">
            {data.projects.length === 0 && (
              <div className="p-4 type-body text-text-3">
                <p>{t("noProjectsYet")}</p>
                {(data.isSuperAdmin || data.adminTeamIds.length > 0) && (
                  <Link to="/projects/new" className="mt-2 inline-block text-accent">
                    {t("createProject")}
                  </Link>
                )}
              </div>
            )}
            {data.projects.map((project) => (
              <Link
                key={project.id}
                to="/projects/$teamId/$projectKey"
                params={{ teamId: project.teamId ?? "none", projectKey: project.key }}
                className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 last:border-b-0 hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1 truncate type-body">{project.name}</span>
                <span className="type-label text-text-3">{project.key}</span>
              </Link>
            ))}
          </Card>
        </div>

        <div>
          <h2 className="mb-2.5 type-headline">{t("myTasks")}</h2>
          <Card className="overflow-hidden">
            {data.myTasks.length === 0 && <p className="p-4 type-body text-text-3">{t("noOpenTasks")}</p>}
            {data.myTasks.map((task) => (
              <Link
                key={task.id}
                to="/issues/$teamId/$projectKey/$issueKeySeq"
                params={{
                  teamId: task.teamId ?? "none",
                  projectKey: task.projectKey,
                  issueKeySeq: String(task.keySeq),
                }}
                className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 last:border-b-0 hover:bg-surface-2"
              >
                <span className="h-3.5 w-3.5 flex-none rounded border-[1.5px] border-border-2" />
                <span className="min-w-0 flex-1 truncate type-body">{task.title}</span>
                {task.dueDate && (
                  <span className="type-label text-text-3">
                    {new Date(task.dueDate).toLocaleDateString(intlLocale, { day: "numeric", month: "short" })}
                  </span>
                )}
              </Link>
            ))}
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}
