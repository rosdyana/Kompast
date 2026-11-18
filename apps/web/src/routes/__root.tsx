import { HeadContent, Scripts, Outlet, createRootRoute, redirect, useMatch } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import themeCss from "@kompast/ui/theme.css?url";
import { ThemeProvider, type Theme } from "@kompast/ui/theme";
import { I18nextProvider, createI18nInstance, DEFAULT_LOCALE, type SupportedLocale } from "@kompast/i18n";
import { ErrorPage } from "@/components/shared/ErrorPage";
import { getSetupStatusFn } from "@/lib/server-fns/setup";
import { getDevLoginStatusFn } from "@/lib/server-fns/dev-login";
import { getThemeFn } from "@/lib/server-fns/theme";
import { getRequestLocaleFn } from "@/lib/server-fns/locale";

export const Route = createRootRoute({
  // Gates the ENTIRE app, not just /login: until Microsoft Entra ID is
  // configured, every route bounces to /setup — there is no working sign-in
  // to fall through to otherwise. /setup and /api/* are excluded to avoid a
  // redirect loop / to let the auth callback route itself. When dev login is
  // enabled (getDevAdminConfig, local dev only), the whole /setup gate is
  // skipped too — that's the point of the bypass: no real Entra tenant
  // needed to reach /login and sign in as the seeded dev-admin account.
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/setup" || location.pathname.startsWith("/api/")) return;
    const devLogin = await getDevLoginStatusFn();
    // Dev login and demo mode both have a working password sign-in, so
    // neither needs a real Entra tenant to get past /setup.
    if (devLogin.enabled || devLogin.demo.enabled) return;
    const status = await getSetupStatusFn();
    if (!status.isConfigured) throw redirect({ to: "/setup" });
  },
  loader: async () => ({ theme: await getThemeFn(), locale: await getRequestLocaleFn() }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Kompast" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap",
      },
      { rel: "stylesheet", href: themeCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
    ],
  }),
  // The <html> document lives in shellComponent, which renders even when this
  // route's own beforeLoad/loader throws (e.g. the database is down). The
  // error and not-found pages below render inside the shell.
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: () => <ErrorPage variant="notFound" fullScreen />,
  errorComponent: ({ error, reset }) => <ErrorPage variant="serverError" error={error} reset={reset} fullScreen />,
});

/**
 * Renders the whole document. It must not depend on the root loader succeeding:
 * when that fails, the match's loaderData is missing, so theme and locale fall
 * back to their defaults. useLoaderData() would throw in that case, so the
 * match is read without throwing.
 */
function RootShell({ children }: { children: ReactNode }) {
  const match = useMatch({ strict: false, shouldThrow: false });
  const data = match?.loaderData as { theme: Theme; locale: SupportedLocale } | undefined;
  return <RootDocument theme={data?.theme ?? "light"} locale={data?.locale ?? DEFAULT_LOCALE}>{children}</RootDocument>;
}

function RootComponent() {
  const { theme, locale } = Route.useLoaderData();
  const i18n = useMemo(() => createI18nInstance(locale), [locale]);
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider initialTheme={theme}>
        <Outlet />
      </ThemeProvider>
    </I18nextProvider>
  );
}

function RootDocument({
  children,
  theme,
  locale,
}: {
  children: ReactNode;
  theme: Theme;
  locale: SupportedLocale;
}) {
  return (
    <html lang={locale} data-theme={theme}>
      <head>
        <meta name="theme-color" content={theme === "dark" ? "#1f1f1e" : "#fbfbfa"} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
