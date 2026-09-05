import { Card } from "@kompast/ui/Card";

/**
 * Static/informational only — deliberately NOT a configurable
 * permission-rule engine. The current role model is four separate
 * vocabularies enforced in code (packages/core/src/permissions.ts,
 * packages/core/src/settings.ts's requireSystemAdmin), not data; this page
 * documents what's actually true today rather than a speculative matrix.
 */
const ROLES = [
  {
    name: "Super Admin",
    scope: "Satu per workspace",
    desc: "Bisa membuat tim baru dan mengelola tim mana pun (member.isSuperAdmin). Memindahkan peran ini mencabutnya dari pemegang sebelumnya.",
  },
  {
    name: "Pemilik / Admin Workspace",
    scope: "Workspace",
    desc: "Bisa membuka Pengaturan (integrasi Entra/AI/Email) dan mengundang/mengelola anggota workspace (member.role).",
  },
  {
    name: "Admin Tim",
    scope: "Per tim",
    desc: "Bisa membuat proyek di timnya sendiri dan mengelola keanggotaan tim tersebut (team_member.role). Tidak punya hak di tim lain atau di seluruh workspace.",
  },
  {
    name: "Anggota Tim",
    scope: "Per tim",
    desc: "Anggota biasa sebuah tim, tanpa hak kelola.",
  },
  {
    name: "Lead / Kontributor / Viewer Proyek",
    scope: "Per proyek",
    desc: "Peran yang bisa ditetapkan per proyek (project_member.role). Belum ditegakkan di mana pun dalam kode saat ini — baru sebatas bisa diberikan.",
  },
];

export function RolesTab() {
  return (
    <div>
      <p className="mb-6 text-sm text-text-2">
        Hierarki peran yang berlaku saat ini di Kompast — bukan matriks izin yang bisa dikonfigurasi, hanya rangkuman dari aturan yang sudah ada di kode.
      </p>
      <Card className="overflow-hidden">
        {ROLES.map((r) => (
          <div key={r.name} className="border-b border-border px-4 py-3 last:border-b-0">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[13px] font-semibold">{r.name}</span>
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] text-text-3">{r.scope}</span>
            </div>
            <p className="text-[12px] leading-relaxed text-text-2">{r.desc}</p>
          </div>
        ))}
      </Card>
    </div>
  );
}
