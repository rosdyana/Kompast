import { createContext, useContext, type ReactNode } from "react";
import type { i18n as I18nInstance } from "i18next";

const I18nReactContext = createContext<I18nInstance | null>(null);

/**
 * Deliberately NOT react-i18next's own useTranslation/I18nextProvider —
 * those internally call React.useSyncExternalStore to react to async
 * namespace/language loading, which this app never needs: every locale's
 * resources are bundled synchronously (see instance.ts's own comment), and
 * a locale switch swaps the WHOLE i18n instance via useMemo in
 * __root.tsx, which already triggers a normal React re-render through
 * this context's value changing — no external-store subscription
 * required. That useSyncExternalStore call also turned out to be
 * incompatible with TanStack Start's custom SSR renderer in production
 * (confirmed via a real docker build: "Cannot read properties of null
 * (reading 'useSyncExternalStore')" on every authenticated page's SSR
 * render). This plain context avoids the whole class of bug, not just
 * this one instance of it.
 */
export function I18nextProvider({ i18n, children }: { i18n: I18nInstance; children: ReactNode }) {
  return <I18nReactContext.Provider value={i18n}>{children}</I18nReactContext.Provider>;
}

type LooseT = (key: string, options?: Record<string, unknown>) => string;

export function useTranslation(ns?: string | string[]) {
  const i18n = useContext(I18nReactContext);
  if (!i18n) throw new Error("useTranslation must be used within an I18nextProvider");

  function t(key: string, options?: Record<string, unknown>): string {
    return (i18n!.t as LooseT)(key, { ns, ...options });
  }

  return { t, i18n };
}
