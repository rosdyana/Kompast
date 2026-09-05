import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";

export const THEME_COOKIE = "kompast-theme";

/**
 * SSR-safe theme resolution: cookie wins, default is "light" — never OS
 * prefers-color-scheme, which is what silently drove dark mode before this.
 * There's no matching setThemeFn: the client toggle writes the cookie
 * directly (document.cookie), since it's not sensitive and must be
 * JS-readable — see packages/ui/src/theme.tsx's toggleTheme.
 */
export const getThemeFn = createServerFn({ method: "GET" }).handler(() => {
  return getCookie(THEME_COOKIE) === "dark" ? ("dark" as const) : ("light" as const);
});
