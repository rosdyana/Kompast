import { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import { adminDb, eq, schema } from "@kompast/db";
import { verifyCollabToken, id, type CollabTokenPayload } from "@kompast/core";

/**
 * documentName -> last time a page_version snapshot was written, so
 * onStoreDocument (which fires on every debounced save) only inserts a
 * history row every VERSION_SNAPSHOT_INTERVAL_MS instead of on every save.
 * In-memory and per-process: fine for the single-collab-instance topology
 * this deploys as (see plan §Deployment) — a multi-instance collab tier
 * would need this moved into Postgres or Redis.
 */
const lastSnapshotAt = new Map<string, number>();
const VERSION_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

export function createCollabServer(port: number) {
  return new Server({
    port,
    quiet: true,

    async onAuthenticate(data) {
      const payload = verifyCollabToken(data.token);
      if (!payload) throw new Error("Invalid or expired collab token");
      if (payload.pageId !== data.documentName) throw new Error("Token does not authorize this document");

      data.connectionConfig.readOnly = payload.role === "view" || payload.role === "comment";
      return payload satisfies CollabTokenPayload;
    },

    async onLoadDocument(data) {
      const [row] = await adminDb.select().from(schema.ydocState).where(eq(schema.ydocState.pageId, data.documentName));
      if (row) Y.applyUpdate(data.document, row.state);
      return data.document;
    },

    async onStoreDocument(data) {
      const state = Buffer.from(Y.encodeStateAsUpdate(data.document));
      const pageId = data.documentName;

      await adminDb
        .insert(schema.ydocState)
        .values({ pageId, state })
        .onConflictDoUpdate({ target: schema.ydocState.pageId, set: { state, updatedAt: new Date() } });

      const now = Date.now();
      const last = lastSnapshotAt.get(pageId) ?? 0;
      if (now - last >= VERSION_SNAPSHOT_INTERVAL_MS) {
        lastSnapshotAt.set(pageId, now);
        await adminDb.insert(schema.pageVersion).values({
          id: id("pageversion"),
          pageId,
          snapshot: state,
          authorId: (data.lastContext as CollabTokenPayload | undefined)?.userId ?? null,
        });
      }
    },
  });
}
