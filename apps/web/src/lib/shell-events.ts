import { listenForShellChanges } from "@kompast/db";

/**
 * Server-only. One Postgres LISTEN per web process, fanned out to every open
 * /api/events stream of the affected workspace (packages/db/realtime.sql
 * sends the notifications). Import it only from server route handlers —
 * never from a server-fn file or a component — or @kompast/db (postgres.js)
 * ends up in the browser bundle (see the v0.5.3 fix and CI's bundle check).
 */

type Listener = () => void;

const byOrg = new Map<string, Set<Listener>>();
/** Streams to nudge after the LISTEN connection (re)subscribes, since notifications sent while it was down are lost. */
const all = new Set<Listener>();
let listening: Promise<unknown> | null = null;
let subscribedOnce = false;

function ensureListening() {
  listening ??= listenForShellChanges(
    (organizationId) => {
      for (const fn of byOrg.get(organizationId) ?? []) fn();
    },
    () => {
      if (subscribedOnce) for (const fn of all) fn();
      subscribedOnce = true;
    },
  ).catch((err) => {
    // Retried on the next subscriber; the browser falls back to polling meanwhile.
    listening = null;
    console.error("[shell-events] LISTEN failed", err);
  });
  return listening;
}

/** Calls `onChange` whenever this workspace's sidebar content may have changed. Returns the unsubscribe. */
export function subscribeShellChanges(organizationId: string, onChange: Listener): () => void {
  void ensureListening();
  let set = byOrg.get(organizationId);
  if (!set) byOrg.set(organizationId, (set = new Set()));
  set.add(onChange);
  all.add(onChange);
  return () => {
    set.delete(onChange);
    if (set.size === 0) byOrg.delete(organizationId);
    all.delete(onChange);
  };
}
