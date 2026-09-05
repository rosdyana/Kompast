import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { getSetupStatusFn, completeSetupFn } from "@/lib/server-fns/setup";

export const Route = createFileRoute("/setup")({
  loader: async () => {
    const status = await getSetupStatusFn();
    if (status.isConfigured) throw redirect({ to: "/login" });
    return status;
  },
  component: SetupPage,
});

function SetupPage() {
  const router = useRouter();
  const [tenantId, setTenantId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      await completeSetupFn({ data: { tenantId: tenantId.trim(), clientId: clientId.trim(), clientSecret } });
      await router.navigate({ to: "/login" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan konfigurasi.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6">
      <div className="w-full max-w-[440px]">
        <div className="mb-7 flex items-center gap-2.5">
          <div className="grid h-[30px] w-[30px] place-items-center rounded-[9px] bg-accent">
            <div className="h-2 w-2 rotate-45 rounded-sm bg-white" />
          </div>
          <span className="text-[17px] font-semibold tracking-tight">Kompast</span>
        </div>

        <h1 className="mb-2 text-2xl font-semibold tracking-tight">Setup awal</h1>
        <p className="mb-7 text-sm leading-relaxed text-text-2">
          Sambungkan Microsoft Entra ID sebelum siapa pun bisa masuk. Anda perlu tenant ID, client ID, dan client
          secret dari app registration di Azure. Orang pertama yang berhasil masuk akan otomatis menjadi admin
          workspace.
        </p>

        <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5">
          <Field label="Tenant ID" value={tenantId} onChange={setTenantId} placeholder="00000000-0000-0000-0000-000000000000" />
          <Field label="Client ID" value={clientId} onChange={setClientId} placeholder="Application (client) ID" />
          <Field
            label="Client Secret"
            value={clientSecret}
            onChange={setClientSecret}
            placeholder="Client secret value"
            type="password"
          />

          {error && <p className="text-[12.5px] text-danger">{error}</p>}

          <Button
            variant="primary"
            onClick={submit}
            disabled={submitting || !tenantId || !clientId || !clientSecret}
            className="w-full py-2.5"
          >
            {submitting ? "Menyimpan…" : "Simpan dan lanjut ke login"}
          </Button>
        </div>

        <p className="mt-5 text-[12px] leading-relaxed text-text-3">
          Redirect URI yang harus terdaftar di app registration:{" "}
          <code className="rounded bg-surface-3 px-1 py-0.5">{"<APP_URL>"}/api/auth/callback/microsoft-entra-id</code>
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-text-2">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-[7px] border border-border-2 bg-surface px-3 py-2 text-[13px] outline-none focus:border-text-3"
      />
    </label>
  );
}
