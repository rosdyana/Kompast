import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

/** Coalesces a burst (a teammate dragging pages around, an import) into one reload. */
const DEBOUNCE_MS = 300;
/** Only while the event stream is down: the plain "poll while visible" fallback. */
const FALLBACK_POLL_MS = 60_000;
/** Coming back to a tab that sat hidden this long refreshes once, whatever the stream says. */
const STALE_ON_RETURN_MS = 30_000;

/**
 * Keeps the sidebar (the /_app loader: teams, projects, page tree) live.
 * Listens to /api/events and re-runs that loader when another person (or an
 * import, MCP client, automation) changes it. If the stream can't connect —
 * a proxy that blocks it, an expired session — falls back to polling every
 * minute while the tab is visible; EventSource keeps retrying meanwhile and
 * the first reconnect refreshes once to catch anything missed.
 */
export function useLiveShell() {
  const router = useRouter();

  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let lastRefresh = Date.now();

    const refresh = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        lastRefresh = Date.now();
        void router.invalidate({ filter: (match) => match.routeId === "/_app" });
      }, DEBOUNCE_MS);
    };
    const startPolling = () => {
      poll ??= setInterval(() => {
        if (document.visibilityState === "visible") refresh();
      }, FALLBACK_POLL_MS);
    };
    const stopPolling = () => {
      clearInterval(poll);
      poll = undefined;
    };

    let source: EventSource | null = null;
    if (typeof EventSource === "undefined") {
      startPolling();
    } else {
      let dropped = false;
      source = new EventSource("/api/events");
      source.addEventListener("shell", refresh);
      source.onopen = () => {
        stopPolling();
        if (dropped) refresh();
        dropped = false;
      };
      source.onerror = () => {
        dropped = true;
        startPolling();
      };
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRefresh > STALE_ON_RETURN_MS) refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      source?.close();
      stopPolling();
      clearTimeout(debounce);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router]);
}
