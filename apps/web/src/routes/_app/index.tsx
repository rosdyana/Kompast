import { createFileRoute, Link } from "@tanstack/react-router";
import { Card } from "@kompast/ui/Card";
import { getHomeSummaryFn } from "@/lib/server-fns/home";

export const Route = createFileRoute("/_app/")({
  loader: () => getHomeSummaryFn(),
  component: HomePage,
});

function HomePage() {
  const data = Route.useLoaderData();

  return (
    <div className="mx-auto max-w-[1080px] px-8 pb-[60px] pt-9">
      <h1 className="mb-[26px] font-serif text-[40px] font-normal tracking-tight">Selamat datang.</h1>

      <div className="grid grid-cols-[1.35fr_1fr] gap-[22px]">
        <div>
          <div className="mb-2.5 flex items-baseline justify-between">
            <h2 className="text-[13.5px] font-semibold">Board aktif</h2>
            {data.activeBoard && (
              <Link
                to="/projects/$projectKey"
                params={{ projectKey: data.projects[0]!.key }}
                className="text-xs text-accent"
              >
                Buka board →
              </Link>
            )}
          </div>
          {data.activeBoard ? (
            <Card className="overflow-hidden">
              <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-3">
                <span className="text-[13px] font-semibold">{data.activeBoard.name}</span>
              </div>
              <div
                className="grid gap-px bg-border"
                style={{ gridTemplateColumns: `repeat(${data.activeBoard.columns.length}, 1fr)` }}
              >
                {data.activeBoard.columns.map((col) => (
                  <div key={col.id} className="bg-surface px-2.5 pb-3.5 pt-2.5">
                    <p className="mb-2 flex items-center gap-1.5 text-[10.5px] font-semibold text-text-2">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: col.color }} />
                      {col.name}
                      <span className="ml-auto font-mono text-text-3">{col.issues.length}</span>
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {col.issues.slice(0, 2).map((issue) => (
                        <div key={issue.id} className="rounded-[7px] border border-border bg-surface-2 px-2 py-1.5">
                          <p className="mb-1 font-mono text-[9px] text-text-3">#{issue.keySeq}</p>
                          <p className="text-[11.5px] leading-tight">{issue.title}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : (
            <Card className="p-4 text-sm text-text-3">Belum ada proyek dengan board.</Card>
          )}

          <h2 className="mb-2.5 mt-[26px] text-[13.5px] font-semibold">Proyek</h2>
          <Card className="overflow-hidden">
            {data.projects.length === 0 && <p className="p-4 text-sm text-text-3">Belum ada proyek.</p>}
            {data.projects.map((project) => (
              <Link
                key={project.id}
                to="/projects/$projectKey"
                params={{ projectKey: project.key }}
                className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 last:border-b-0 hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{project.name}</span>
                <span className="font-mono text-[10px] text-text-3">{project.key}</span>
              </Link>
            ))}
          </Card>
        </div>

        <div>
          <h2 className="mb-2.5 text-[13.5px] font-semibold">Tugas saya</h2>
          <Card className="overflow-hidden">
            {data.myTasks.length === 0 && <p className="p-4 text-sm text-text-3">Tidak ada tugas terbuka.</p>}
            {data.myTasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 last:border-b-0"
              >
                <span className="h-3.5 w-3.5 flex-none rounded border-[1.5px] border-border-2" />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{task.title}</span>
                {task.dueDate && (
                  <span className="font-mono text-[10px] text-text-3">
                    {new Date(task.dueDate).toLocaleDateString("id-ID", { day: "numeric", month: "short" })}
                  </span>
                )}
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}
