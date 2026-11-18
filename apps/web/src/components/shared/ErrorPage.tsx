import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { createI18nInstance, DEFAULT_LOCALE, useOptionalI18n } from "@kompast/i18n";

type I18nInstance = ReturnType<typeof createI18nInstance>;

/**
 * Copy of GENERIC_ERROR_PREFIX from apps/web/src/lib/public-error.ts. Kept
 * here as a duplicate because public-error.ts is server-only (it pulls in
 * auth and the database), and this component ships to the browser. Keep the
 * two in sync.
 */
const GENERIC_ERROR_PREFIX = "Something went wrong. Reference: ";
/** Same shape newErrorReference() produces: 4 chars, dash, 4 chars. */
const REFERENCE_PATTERN = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;

export type ErrorPageVariant = "notFound" | "noAccess" | "serverError" | "offline";

const CODE: Record<ErrorPageVariant, string | null> = {
  notFound: "404",
  // Deliberately 404 too, never 403: RLS hides "exists but not yours" as "doesn't exist".
  noAccess: "404",
  serverError: "500",
  offline: null,
};

/**
 * The error page used for 404, no-access, 500 and offline states. Shows a
 * status code, a short explanation and actions. It never renders the raw
 * error text; in dev only, a collapsed details block shows the error.
 *
 * Works with no I18nextProvider above it (a root-level failure), using the
 * default locale in that case.
 */
export function ErrorPage({
  variant,
  error,
  reset,
  fullScreen,
}: {
  variant: ErrorPageVariant;
  error?: unknown;
  reset?: () => void;
  fullScreen?: boolean;
}) {
  const provided = useOptionalI18n();
  const fallback = useMemo(() => (provided ? null : createI18nInstance(DEFAULT_LOCALE)), [provided]);
  const i18n = (provided ?? fallback) as I18nInstance;
  const t = (key: string, options?: Record<string, unknown>) =>
    String((i18n.t as unknown as (k: string, o?: Record<string, unknown>) => string)(key, { ns: "common", ...options }));

  const router = useRouter({ warn: false });
  const [offlineNow, setOfflineNow] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  // Read browser state after mount: navigator/history don't exist during SSR,
  // and reading them in render would cause a hydration mismatch.
  useEffect(() => {
    setOfflineNow(typeof navigator !== "undefined" && navigator.onLine === false);
    setCanGoBack(typeof window !== "undefined" && window.history.length > 1);
  }, []);

  // A failed network call inside a server function surfaces as a TypeError
  // ("Failed to fetch", "NetworkError ..."); treat that as offline, not a server bug.
  const looksOffline = error instanceof TypeError && /fetch|network/i.test(error.message);
  const effective: ErrorPageVariant = variant === "serverError" && (offlineNow || looksOffline) ? "offline" : variant;

  const generic = error instanceof Error && error.message.startsWith(GENERIC_ERROR_PREFIX) ? error.message.slice(GENERIC_ERROR_PREFIX.length) : null;
  const reference = generic && REFERENCE_PATTERN.test(generic) ? generic : null;

  const copy = {
    notFound: { title: "notFoundTitle", text: "notFoundSubtext" },
    noAccess: { title: "noAccessTitle", text: "noAccessSubtext" },
    serverError: { title: "serverErrorTitle", text: "serverErrorSubtext" },
    offline: { title: "offlineTitle", text: "offlineSubtext" },
  }[effective];

  const retry = () => {
    reset?.();
    router?.invalidate();
  };

  const primaryClass = "inline-flex h-8 items-center rounded-[6px] bg-accent px-3 text-[14px] font-medium text-white hover:bg-accent-hover";
  const secondaryClass = "inline-flex h-8 items-center rounded-[6px] border border-border-2 bg-surface px-3 text-[14px] text-text hover:bg-surface-2";
  const code = CODE[effective];

  return (
    <div className={`flex flex-1 flex-col items-center justify-center px-6 py-16 text-center${fullScreen ? " min-h-screen bg-bg" : ""}`}>
      {code && <div className="text-[64px] font-semibold leading-none tracking-tight text-text-3 tabular-nums">{code}</div>}
      <div className="my-5 h-px w-12 bg-border-2" />
      <h1 className="type-headline text-text">{t(copy.title)}</h1>
      <p className="mt-1 max-w-[420px] type-small text-center text-text-2">{t(copy.text)}</p>
      {reference && <p className="mt-3 font-mono text-[12px] text-text-3">{t("errorReference", { ref: reference })}</p>}

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {effective === "notFound" || effective === "noAccess" ? (
          <>
            <Link to="/" className={primaryClass}>
              {t("notFoundGoHome")}
            </Link>
            {canGoBack && (
              <button type="button" onClick={() => window.history.back()} className={secondaryClass}>
                {t("goBack")}
              </button>
            )}
          </>
        ) : effective === "serverError" ? (
          <>
            <button type="button" onClick={retry} className={primaryClass}>
              {t("tryAgain")}
            </button>
            <Link to="/" className={secondaryClass}>
              {t("notFoundGoHome")}
            </Link>
          </>
        ) : (
          <button type="button" onClick={retry} className={primaryClass}>
            {t("tryAgain")}
          </button>
        )}
      </div>

      {import.meta.env.DEV && error !== undefined && (
        <details className="mt-8 max-w-[640px] text-left text-[12px] text-text-3">
          <summary className="cursor-pointer">{t("developerDetails")}</summary>
          <pre className="mt-2 max-h-[300px] overflow-auto whitespace-pre-wrap break-all rounded-[6px] bg-surface-2 p-3 font-mono">
            {String(error)}
            {error instanceof Error && error.stack ? `\n${error.stack}` : ""}
          </pre>
        </details>
      )}
    </div>
  );
}
