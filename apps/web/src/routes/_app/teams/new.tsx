import { createFileRoute, redirect, useLoaderData, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { Card } from "@kompast/ui/Card";
import { createTeamFn } from "@/lib/server-fns/teams";

export const Route = createFileRoute("/_app/teams/new")({
  component: NewTeamPage,
});

function NewTeamPage() {
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
      setError(err instanceof Error ? err.message : "Gagal membuat tim");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-[520px] px-8 pb-16 pt-9">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Tim baru</h1>
      <p className="mb-8 text-sm text-text-2">
        Setiap proyek di Kompast dimiliki oleh sebuah tim. Buat tim pertama untuk workspace ini.
      </p>

      <Card className="flex flex-col gap-3 p-4">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="Nama tim, mis. Cloud Platform Team"
          autoFocus
          className="min-w-0 flex-1 rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none"
        />
        {error && <p className="text-[12px] text-danger">{error}</p>}
        <Button variant="primary" onClick={create} disabled={creating || !name.trim()} className="self-start">
          {creating ? "Membuat…" : "Buat tim"}
        </Button>
      </Card>
    </div>
  );
}
