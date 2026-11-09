import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import {
  createNotionMigration,
  deleteNotionMigration,
  getImportRun,
  getNotionMigration,
  listNotionMigrations,
  pageImportTargetKey,
  parseNotionSelection,
  requestNotionDiscovery,
  resolveExternalRef,
  retryNotionMigration,
  saveNotionSelection,
  startNotionMigrationRun,
  updateNotionMigrationToken,
  withAuthorizedTenant,
  type AuthContext,
} from "@kompast/core";
import { createNotionClient, NotionApiError } from "@kompast/import";
import { requireAuthContext } from "../session";

/**
 * The Notion API migration wizard's server functions. Thin adapters: auth from
 * the session, then the core function does the work and its own checks. The
 * integration token goes in and never comes back out; reads expose only
 * `hasToken` (packages/core/src/notion-migration.ts). The Notion calls run
 * outside any transaction, so no connection is held while waiting on Notion.
 */

const tokenSchema = z.string().trim().min(1, "Enter the Notion integration token").max(500);
const idSchema = z.object({ id: z.string().min(1) });

const selectionTargetSchema = z.union([
  z.literal("workspace"),
  z.literal("private"),
  z.object({ team: z.string().min(1).max(100) }),
]);

const selectionSchema = z.object({
  roots: z
    .array(
      z.object({
        notionId: z.string().min(1).max(100),
        title: z.string().max(500),
        target: selectionTargetSchema,
      }),
    )
    .max(500),
});

/**
 * The Notion workspace the token belongs to, read from GET /users/me. Runs
 * outside a transaction. Fixed host (api.notion.com), so no SSRF concern.
 */
async function workspaceNameFor(token: string): Promise<string> {
  const client = createNotionClient({ token });
  try {
    const me = await client.me();
    return me.bot?.workspace_name ?? me.name ?? "";
  } catch (err) {
    if (err instanceof NotionApiError && err.status === 401) {
      throw new Error("Notion rejected this token. Copy the integration's secret again from notion.so/profile/integrations.");
    }
    if (err instanceof NotionApiError) {
      throw new Error(`Notion returned an error (${err.status}). Try again in a moment.`);
    }
    throw new Error("Could not reach Notion. Check the connection and try again.");
  }
}

/** Any workspace member may use the wizard. Membership is checked in its own short transaction, closed before any Notion call. */
async function requireMember(ctx: AuthContext): Promise<void> {
  await withAuthorizedTenant(ctx, async () => undefined);
}

/** Checks a token against Notion and returns the workspace name it belongs to. Stores nothing. */
export const checkNotionTokenFn = createServerFn({ method: "POST" })
  .validator(z.object({ token: tokenSchema }))
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireMember(ctx);
    return { workspaceName: await workspaceNameFor(data.token) };
  });

/** Checks the token, then connects the workspace: a migration in "discovering" whose page tree the worker reads next. */
export const createNotionMigrationFn = createServerFn({ method: "POST" })
  .validator(z.object({ token: tokenSchema }))
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireMember(ctx);
    const workspaceName = await workspaceNameFor(data.token);
    return withAuthorizedTenant(ctx, (tx) => createNotionMigration(tx, ctx, { token: data.token, workspaceName }));
  });

/** The caller's own migrations, newest first. Only the fields the list shows; the discovery and cursor stay on the server. */
export const listNotionMigrationsFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();
  return withAuthorizedTenant(ctx, async (tx) => {
    const rows = await listNotionMigrations(tx);
    return rows.map((row) => ({
      id: row.id,
      workspaceName: row.workspaceName,
      state: row.state,
      error: row.error,
      hasToken: row.hasToken,
      importRunId: row.importRunId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  });
});

/** One migration, without its resume cursor (which holds the runner's large state). Null when the caller can't see it. */
export const getNotionMigrationFn = createServerFn({ method: "GET" })
  .validator(idSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      const row = await getNotionMigration(tx, data.id);
      if (!row) return null;
      const { cursor: _cursor, ...migration } = row;
      return migration;
    });
  });

/** Replaces the token after checking it against Notion. Refused by core while a discovery or run is in progress. */
export const updateNotionTokenFn = createServerFn({ method: "POST" })
  .validator(idSchema.extend({ token: tokenSchema }))
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireMember(ctx);
    const workspaceName = await workspaceNameFor(data.token);
    await withAuthorizedTenant(ctx, (tx) => updateNotionMigrationToken(tx, ctx, data.id, { token: data.token, workspaceName }));
    return { ok: true } as const;
  });

/** Queues a fresh scan of the workspace (after pages were shared, or the first scan came back empty). */
export const rediscoverNotionFn = createServerFn({ method: "POST" })
  .validator(idSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => requestNotionDiscovery(tx, ctx, data.id));
    return { ok: true } as const;
  });

/** Saves the picked root pages and their targets. Core re-checks the shape and each target against the caller. */
export const saveNotionSelectionFn = createServerFn({ method: "POST" })
  .validator(idSchema.extend({ selection: selectionSchema }))
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => saveNotionSelection(tx, ctx, data.id, data.selection));
    return { ok: true } as const;
  });

/** Starts the background run. The worker picks it up within a few seconds. */
export const startNotionMigrationFn = createServerFn({ method: "POST" })
  .validator(idSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => startNotionMigrationRun(tx, ctx, data.id));
  });

/** Retries a failed migration. The token is kept, so no re-entry is needed. */
export const retryNotionMigrationFn = createServerFn({ method: "POST" })
  .validator(idSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => retryNotionMigration(tx, ctx, data.id));
  });

/** Forgets the migration and its token. Imported pages stay where they are. */
export const deleteNotionMigrationFn = createServerFn({ method: "POST" })
  .validator(idSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => deleteNotionMigration(tx, ctx, data.id));
    return { ok: true } as const;
  });

export interface NotionImportReport {
  status: "pending" | "running" | "completed" | "failed";
  counts: Record<string, number>;
  errors: { page: string; error: string }[];
  /** Kompast page ids of the picked root pages that were imported, in selection order. Empty until they exist. */
  rootPageIds: string[];
}

/**
 * The newest import run's counts and errors for this migration, plus the page
 * ids of its root pages (looked up through their external refs, since the
 * resume cursor is dropped when a run finishes). Null before a run starts.
 */
export const getNotionImportReportFn = createServerFn({ method: "GET" })
  .validator(idSchema)
  .handler(async ({ data }): Promise<NotionImportReport | null> => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      const migration = await getNotionMigration(tx, data.id);
      if (!migration || migration.createdBy !== ctx.userId) throw new Error("Notion migration not found");
      if (!migration.importRunId) return null;
      const run = await getImportRun(tx, migration.importRunId);
      if (!run) return null;

      const roots = migration.selection ? parseNotionSelection(migration.selection).roots : [];
      const rootPageIds: string[] = [];
      for (const root of roots) {
        const ref = await resolveExternalRef(tx, ctx.organizationId, "notion", `${pageImportTargetKey(root.target, ctx.userId)}:${root.notionId}`);
        if (ref) rootPageIds.push(ref.entityId);
      }

      const counts = (run.counts ?? {}) as Record<string, number>;
      const errors = Array.isArray(run.errors) ? (run.errors as { page: string; error: string }[]) : [];
      return { status: run.status, counts, errors, rootPageIds };
    });
  });
