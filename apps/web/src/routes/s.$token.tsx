import "@blocknote/core/style.css";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Eye, Lock, LogIn } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { Spinner } from "@kompast/ui/EmptyState";
import { useTranslation } from "@kompast/i18n";
import { getSharedPageMetaFn, getSharedPageContentFn } from "@/lib/server-fns/share";
import { CompassMark } from "@/components/shell/ProjectIcon";
import { isMermaidLanguage, renderMermaidSvg } from "@/lib/mermaid-render";

/**
 * A pre that holds a Mermaid source. The exporter puts the language on the
 * block wrapper (`data-content-type="codeBlock" data-language="mermaid"`, the
 * shape sanitizeShareHtml keeps); the `code.language-mermaid` form is also
 * accepted so either export path works.
 */
function isMermaidPre(pre: HTMLElement): boolean {
  if (pre.querySelector("code")?.classList.contains("language-mermaid")) return true;
  const block = pre.closest<HTMLElement>('[data-content-type="codeBlock"]');
  return isMermaidLanguage(block?.dataset.language);
}

export const Route = createFileRoute("/s/$token")({
  loader: ({ params }) => getSharedPageMetaFn({ data: params.token }),
  component: SharedPage,
});

function Shell({ children, title }: { children: ReactNode; title?: string }) {
  const { t } = useTranslation("share");
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <header className="flex h-12 flex-none items-center gap-2.5 border-b border-border px-4 sm:px-6">
        <CompassMark size={20} />
        <span className="text-[14px] font-semibold text-text">Kompast</span>
        {title && <span className="min-w-0 truncate text-[14px] text-text-3">/ {title}</span>}
        <span className="ml-auto flex flex-none items-center gap-1.5 text-[12.5px] text-text-3">
          <Eye size={14} strokeWidth={1.75} />
          <span className="hidden sm:inline">{t("sharedFooter")}</span>
        </span>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex min-h-[70vh] w-full max-w-[380px] flex-col items-center justify-center px-6 text-center">{children}</div>;
}

function Icon({ icon, size }: { icon: string | null; size: number }) {
  return icon ? <span style={{ fontSize: size, lineHeight: 1 }}>{icon}</span> : null;
}

function SharedPage() {
  const { t } = useTranslation("share");
  const meta = Route.useLoaderData();
  const { token } = Route.useParams();
  const [password, setPassword] = useState("");
  const [content, setContent] = useState<{ title: string; icon: string | null; html: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // A session that ended between the meta load and the content fetch.
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const docRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (meta && !meta.loginRequired && !meta.requiresPassword) {
      getSharedPageContentFn({ data: { token } }).then((res) => {
        if (res.ok) setContent(res);
        else if (res.loginRequired) setNeedsSignIn(true);
        else setError(t("invalidLink"));
      });
    }
  }, [meta, token, t]);

  // Mermaid diagrams are drawn client-side after the sanitized HTML is in the DOM.
  // The source <pre> stays in place as the fallback: it is hidden only once a
  // diagram renders, so a syntax error leaves the code visible.
  const contentHtml = content?.html;
  useEffect(() => {
    const root = docRef.current;
    if (!root || !contentHtml) return;
    let cancelled = false;
    const applied: { pre: HTMLElement; preview: HTMLElement }[] = [];
    const pres = Array.from(root.querySelectorAll("pre")).filter(isMermaidPre);
    for (const pre of pres) {
      const source = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
      renderMermaidSvg(source).then((res) => {
        if (cancelled || !("svg" in res) || !res.svg) return;
        const preview = document.createElement("div");
        preview.className = "kp-mermaid-preview";
        preview.innerHTML = res.svg;
        pre.after(preview);
        pre.style.display = "none";
        applied.push({ pre, preview });
      });
    }
    return () => {
      cancelled = true;
      for (const { pre, preview } of applied) {
        preview.remove();
        pre.style.display = "";
      }
    };
  }, [contentHtml]);

  async function submitPassword() {
    setLoading(true);
    setError("");
    try {
      const res = await getSharedPageContentFn({ data: { token, password } });
      if (res.ok) setContent(res);
      else if (res.loginRequired) setNeedsSignIn(true);
      else setError(t("wrongPassword"));
    } catch (err) {
      // The server throws (rather than returning ok:false) when password attempts are rate-limited; its message says how long to wait.
      setError(err instanceof Error ? err.message : t("wrongPassword"));
    } finally {
      setLoading(false);
    }
  }

  if (!meta) {
    return (
      <Shell>
        <Centered>
          <p className="text-[15px] text-text-2">{t("invalidLink")}</p>
        </Centered>
      </Shell>
    );
  }

  // Signed-in-only link, no session: say nothing about the page itself, just offer sign-in and come back here.
  if (meta.loginRequired || needsSignIn) {
    return (
      <Shell>
        <Centered>
          <span className="mb-4 grid h-11 w-11 place-items-center rounded-full bg-surface-3 text-text-2">
            <Lock size={18} />
          </span>
          <h1 className="mb-1 text-[18px] font-semibold">{t("signInRequiredTitle")}</h1>
          <p className="mb-5 text-[14px] text-text-2">{t("signInRequiredBody")}</p>
          <Button variant="primary" className="w-full" onClick={() => window.location.assign(`/login?redirect=${encodeURIComponent(`/s/${token}`)}`)}>
            <LogIn size={15} />
            {t("signInToView")}
          </Button>
        </Centered>
      </Shell>
    );
  }

  if (meta.requiresPassword && !content) {
    return (
      <Shell>
        <Centered>
          <span className="mb-4 grid h-11 w-11 place-items-center rounded-full bg-surface-3 text-text-2">
            {meta.icon ? <Icon icon={meta.icon} size={22} /> : <Lock size={18} />}
          </span>
          <h1 className="mb-1 text-[18px] font-semibold">{meta.title || t("untitled")}</h1>
          <p className="mb-5 text-[14px] text-text-2">{t("passwordProtected")}</p>
          <form
            className="flex w-full flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitPassword();
            }}
          >
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("passwordPlaceholder")}
              aria-label={t("passwordPlaceholder")}
              aria-invalid={!!error}
              autoFocus
              className="kp-input"
            />
            {error && <p className="text-left text-[13px] text-danger">{error}</p>}
            <Button type="submit" variant="primary" className="w-full" disabled={loading || !password}>
              {t("open")}
            </Button>
          </form>
        </Centered>
      </Shell>
    );
  }

  if (!content) {
    return (
      <Shell title={meta.title}>
        <Centered>{error ? <p className="text-[15px] text-text-2">{error}</p> : <Spinner size={18} />}</Centered>
      </Shell>
    );
  }

  return (
    <Shell title={content.title || t("untitled")}>
      <article className="mx-auto w-full max-w-[760px] px-6 pb-24 pt-12 sm:px-[30px] sm:pt-16">
        {content.icon && (
          <div className="mb-3">
            <Icon icon={content.icon} size={60} />
          </div>
        )}
        <h1 className="mb-6 text-[40px] font-bold leading-[1.2] tracking-[-0.02em] text-text">{content.title || t("untitled")}</h1>
        {content.html ? (
          <div ref={docRef} className="kp-doc kp-doc-static bn-default-styles" dangerouslySetInnerHTML={{ __html: content.html }} />
        ) : (
          <p className="text-[15px] text-text-3">{t("emptyPage")}</p>
        )}
        <p className="mt-16 flex items-center gap-2 border-t border-border pt-5 text-[12.5px] text-text-3">
          <CompassMark size={14} />
          {t("poweredBy")}
        </p>
      </article>
    </Shell>
  );
}
