import { HeadContent, Scripts, Outlet, createRootRoute, redirect } from "@tanstack/react-router";
import type { ReactNode } from "react";
import themeCss from "@kompast/ui/theme.css?url";
import { getSetupStatusFn } from "@/lib/server-fns/setup";

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
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
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
