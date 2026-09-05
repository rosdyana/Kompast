import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@kompast/ui/Button";
import { signInWithMicrosoft } from "@/lib/auth-client";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  return (
    <div className="grid min-h-screen grid-cols-[1.05fr_0.95fr] bg-bg">
      <div className="relative flex flex-col justify-between overflow-hidden bg-indigo px-15 py-14 text-white">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(circle at 78% 22%, rgba(255,255,255,.1), transparent 42%), linear-gradient(rgba(255,255,255,.06) 1px,transparent 1px), linear-gradient(90deg,rgba(255,255,255,.06) 1px,transparent 1px)",
            backgroundSize: "auto, 44px 44px, 44px 44px",
          }}
        />
        <div className="relative flex items-center gap-2.5">
          <div className="grid h-[30px] w-[30px] place-items-center rounded-[9px] bg-accent">
            <div className="h-2 w-2 rotate-45 rounded-sm bg-white" />
          </div>
          <span className="text-[17px] font-semibold tracking-tight">Kompast</span>
        </div>
        <div className="relative max-w-[430px]">
          <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.14em] text-white/55">
            Docs · Tabel · Kanban · Otomasi
          </p>
          <h1 className="font-serif text-[52px] font-normal leading-[1.04] tracking-tight">
            Satu arah untuk sprint dan pengetahuan tim.
          </h1>
          <p className="mt-5 text-[15px] leading-relaxed text-white/72">
            Tiket, tabel, dan dokumen hidup di database yang sama. Ganti view, bukan tool.
          </p>
        </div>
        <div className="relative flex gap-7 text-[12.5px] text-white/60">
          <span>Workspace &amp; team</span>
          <span>Peran granular</span>
          <span>SSO Microsoft</span>
        </div>
      </div>

      <div className="flex items-center justify-center p-12">
        <div className="w-full max-w-[352px]">
          <h2 className="mb-2 text-[25px] font-semibold tracking-tight">Masuk ke Kompast</h2>
          <p className="mb-7 text-sm leading-relaxed text-text-2">
            Gunakan akun kerja Anda. Workspace dipilih otomatis dari direktori organisasi.
          </p>
          <Button variant="dark" className="w-full py-3.5 text-[14.5px]" onClick={() => signInWithMicrosoft()}>
            <MicrosoftGlyph />
            Lanjut dengan Microsoft
          </Button>
          <div className="my-[22px] flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-[11.5px] text-text-3">atau</span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <Button variant="outline" className="w-full py-3 text-[14px]" onClick={() => signInWithMicrosoft()}>
            Masuk dengan tautan email
          </Button>
          <p className="mt-7 text-[12px] leading-relaxed text-text-3">
            Dengan masuk Anda menyetujui <a href="#">Ketentuan Layanan</a> dan{" "}
            <a href="#">Kebijakan Privasi</a> Kompast.
          </p>
          <div className="mt-[34px] flex items-start gap-2.5 rounded-[9px] border border-dashed border-border-2 bg-surface-2 p-3.5">
            <div className="mt-1.5 h-1.5 w-1.5 animate-[kp-blink_2.2s_infinite] rounded-full bg-green" />
            <p className="text-[12px] leading-relaxed text-text-2">
              Tenant <strong className="text-text">asus.com</strong> terdeteksi — Anda akan masuk
              sebagai anggota workspace <strong className="text-text">Cloud Platform</strong>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function MicrosoftGlyph() {
  return (
    <span className="grid grid-cols-2 grid-rows-2 gap-0.5" style={{ width: 16, height: 16 }}>
      <i className="bg-[#f25022]" />
      <i className="bg-[#7fba00]" />
      <i className="bg-[#00a4ef]" />
      <i className="bg-[#ffb900]" />
    </span>
  );
}

