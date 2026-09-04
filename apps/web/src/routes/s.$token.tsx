import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@kompast/ui/Button";
import { getSharedPageMetaFn, getSharedPageContentFn } from "@/lib/server-fns/share";

export const Route = createFileRoute("/s/$token")({
  loader: ({ params }) => getSharedPageMetaFn({ data: params.token }),
  component: SharedPage,
});

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6">
      <div className="w-full max-w-[380px] text-center">{children}</div>
    </div>
  );
}

function SharedPage() {
  const meta = Route.useLoaderData();
  const { token } = Route.useParams();
  const [password, setPassword] = useState("");
  const [content, setContent] = useState<{ title: string; icon: string | null; html: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (meta && !meta.requiresPassword) {
      getSharedPageContentFn({ data: { token } }).then((res) => {
        if (res.ok) setContent(res);
      });
    }
  }, [meta, token]);

  async function submitPassword() {
    setLoading(true);
    setError("");
    try {
      const res = await getSharedPageContentFn({ data: { token, password } });
      if (res.ok) setContent(res);
      else setError("Kata sandi salah.");
    } finally {
      setLoading(false);
    }
  }

  if (!meta) {
    return (
      <Centered>
        <p className="text-sm text-text-3">Tautan tidak valid atau sudah kedaluwarsa.</p>
      </Centered>
    );
  }

  if (meta.requiresPassword && !content) {
    return (
      <Centered>
        <div className="mb-4 text-3xl">{meta.icon || "▤"}</div>
        <h1 className="mb-1 text-lg font-semibold">{meta.title || "Tanpa judul"}</h1>
        <p className="mb-4 text-sm text-text-3">Halaman ini dilindungi kata sandi.</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submitPassword()}
          placeholder="Kata sandi"
          className="mb-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-border-2"
        />
        {error && <p className="mb-2 text-[12px] text-accent">{error}</p>}
        <Button variant="primary" className="w-full" onClick={submitPassword} disabled={loading || !password}>
          Buka
        </Button>
      </Centered>
    );
  }

  if (!content) {
    return (
      <Centered>
        <p className="text-sm text-text-3">Memuat…</p>
      </Centered>
    );
  }

  return (
    <div className="min-h-screen bg-bg">
      <header className="border-b border-border bg-surface-2 px-6 py-3 text-center text-[11.5px] text-text-3">
        Dibagikan dari Kompast — hanya lihat
      </header>
      <div className="mx-auto max-w-[820px] px-8 py-12">
        <h1 className="mb-6 flex items-center gap-2.5 text-3xl font-semibold tracking-tight">
          <span>{content.icon || "▤"}</span>
          {content.title || "Tanpa judul"}
        </h1>
        <div className="bn-shared-content text-[15px] leading-relaxed" dangerouslySetInnerHTML={{ __html: content.html }} />
      </div>
    </div>
  );
}
