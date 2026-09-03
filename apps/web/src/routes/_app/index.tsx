import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@kompast/ui/Card";
import { stats, miniColumns, autoFeed, recentDocs, myTasks } from "@/lib/mock-data";

export const Route = createFileRoute("/_app/")({
  component: HomePage,
});

function HomePage() {
  return (
    <div className="mx-auto max-w-[1080px] px-8 pb-[60px] pt-9">
      <p className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[0.13em] text-text-3">
        Rabu, 3 September · Sprint 24 · hari ke-6 dari 10
      </p>
      <h1 className="mb-[26px] font-serif text-[40px] font-normal tracking-tight">
        Selamat pagi, Rani.
      </h1>

      <div className="mb-7 grid grid-cols-4 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="rounded-[11px] border border-border bg-surface p-3.5">
            <p className="mb-2 text-[11.5px] text-text-2">{s.label}</p>
            <p className="flex items-baseline gap-1.5">
              <span className="text-[26px] font-semibold tracking-tight">{s.value}</span>
              <span className="text-[11px] font-semibold" style={{ color: s.deltaColor }}>
                {s.delta}
              </span>
            </p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-[1.35fr_1fr] gap-[22px]">
        <div>
          <div className="mb-2.5 flex items-baseline justify-between">
            <h2 className="text-[13.5px] font-semibold">Board aktif</h2>
            <span className="text-xs text-accent">Buka board →</span>
          </div>
          <Card className="overflow-hidden">
            <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-3">
              <span className="grid h-4 w-4 place-items-center rounded-[5px] bg-indigo-soft text-[9px] font-bold text-indigo">
                K
              </span>
              <span className="text-[13px] font-semibold">Kompast Core</span>
              <span className="font-mono text-[10px] text-text-3">32 tiket · 4 blocked</span>
            </div>
            <div className="grid grid-cols-4 gap-px bg-border">
              {miniColumns.map((m) => (
                <div key={m.name} className="bg-surface px-2.5 pb-3.5 pt-2.5">
                  <p className="mb-2 flex items-center gap-1.5 text-[10.5px] font-semibold text-text-2">
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: m.color }}
                    />
                    {m.name}
                    <span className="ml-auto font-mono text-text-3">{m.count}</span>
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {m.cards.map((mc) => (
                      <div
                        key={mc.key}
                        className="rounded-[7px] border border-border bg-surface-2 px-2 py-1.5"
                      >
                        <p className="mb-1 font-mono text-[9px] text-text-3">{mc.key}</p>
                        <p className="text-[11.5px] leading-tight">{mc.title}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <h2 className="mb-2.5 mt-[26px] text-[13.5px] font-semibold">Otomasi berjalan</h2>
          <Card className="overflow-hidden">
            {autoFeed.map((a, i) => (
              <div
                key={i}
                className="flex items-start gap-2.5 border-b border-border px-3.5 py-3 last:border-b-0"
              >
                <div
                  className="grid h-[22px] w-[22px] flex-none place-items-center rounded-md text-[10px]"
                  style={{ background: a.bg, color: a.fg }}
                >
                  {a.glyph}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="mb-0.5 text-[12.5px] leading-snug">{a.text}</p>
                  <p className="font-mono text-[10px] text-text-3">
                    {a.rule} · {a.time}
                  </p>
                </div>
              </div>
            ))}
          </Card>
        </div>

        <div>
          <div className="mb-2.5 flex items-baseline justify-between">
            <h2 className="text-[13.5px] font-semibold">Doc terbaru</h2>
            <span className="text-xs text-accent">Semua →</span>
          </div>
          <div className="flex flex-col gap-2">
            {recentDocs.map((d) => (
              <button
                key={d.title}
                className="block w-full rounded-[10px] border border-border bg-surface p-3 text-left hover:border-border-2 hover:shadow-kp"
              >
                <p className="mb-1 font-serif text-base leading-tight">{d.title}</p>
                <p className="mb-2 text-[11.5px] leading-snug text-text-2">{d.excerpt}</p>
                <p className="flex items-center gap-1.5 text-[10.5px] text-text-3">
                  <span
                    className="rounded px-1.5 py-px font-semibold"
                    style={{ background: d.bg, color: d.fg }}
                  >
                    {d.tag}
                  </span>
                  {d.meta}
                </p>
              </button>
            ))}
          </div>

          <h2 className="mb-2.5 mt-[26px] text-[13.5px] font-semibold">Tugas saya minggu ini</h2>
          <Card className="overflow-hidden">
            {myTasks.map((t) => (
              <div
                key={t.title}
                className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 last:border-b-0"
              >
                <span className="h-3.5 w-3.5 flex-none rounded border-[1.5px] border-border-2" />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{t.title}</span>
                <span className="font-mono text-[10px]" style={{ color: t.dueColor }}>
                  {t.due}
                </span>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}
