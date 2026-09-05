import { HeadContent, Scripts, Outlet, createRootRoute, redirect } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import themeCss from "@kompast/ui/theme.css?url";
import { ThemeProvider, type Theme } from "@kompast/ui/theme";
import { I18nextProvider, createI18nInstance, type SupportedLocale } from "@kompast/i18n";
import { getSetupStatusFn } from "@/lib/server-fns/setup";
import { getThemeFn } from "@/lib/server-fns/theme";
import { getRequestLocaleFn } from "@/lib/server-fns/locale";

export const Route = createRootRoute({
  // Gates the ENTIRE app, not just /login: until Microsoft Entra ID is
  // configured, every route bounces to /setup — there is no working sign-in
  // to fall through to otherwise. /setup and /api/* are excluded to avoid a
  // redirect loop / to let the auth callback route itself.
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/setup" || location.pathname.startsWith("/api/")) return;
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
        href: "https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400..700;1,400..600&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;600&display=swap",
      },
      { rel: "stylesheet", href: themeCss },
      { rel: "icon", href: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  const { theme, locale } = Route.useLoaderData();
  const i18n = useMemo(() => createI18nInstance(locale), [locale]);
  return (
    <RootDocument theme={theme} locale={locale}>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider initialTheme={theme}>
          <Outlet />
        </ThemeProvider>
      </I18nextProvider>
    </RootDocument>
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
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
