import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import {
  createJiraMigration,
  deleteJiraMigration,
  finishJiraMigration,
  getJiraMigration,
  getJiraMigrationForProject,
  getLatestJiraMigrationRun,
  getLatestJiraReconcile,
  getJiraProjectRef,
  jiraKeySeqsOf,
  listAttachmentsLeftInJira,
  listJiraMigrationRuns,
  setJiraMigrationAutoSync,
  listJiraMappingTargets,
  requestJiraDiscovery,
  requireProjectAccess,
  requireProjectAdmin,
  saveJiraMigrationMapping,
  startJiraMigrationRun,
  updateJiraMigrationCredentials,
  withAuthorizedTenant,
  type AuthContext,
} from "@kompast/core";
import {
  checkJiraConnection,
  listJiraBoards,
  previewJiraMigrationPlan,
  type JiraDiscovery,
  type JiraMigrationMapping,
} from "@kompast/import";
import { requireAuthContext } from "../session";

/**
 * The JIRA migration wizard's server functions. Each one is a thin adapter:
 * auth from the session, then the core or import function does the work and
 * its own permission check. The API token goes in and never comes back out:
 * reads expose only `hasToken`.
 */

// The site must be https. Trailing slashes are stripped in the handlers.
const siteUrlSchema = z.url().refine((url) => url.startsWith("https://"), { message: "The JIRA site must start with https://" });

const connectionSchema = z.object({
  siteUrl: siteUrlSchema,
  email: z.email(),
  apiToken: z.string().min(1),
});

function baseUrlOf(siteUrl: string): string {
  return siteUrl.replace(/\/+$/, "");
}

/**
 * Only a project admin may make the server call JIRA with a token: otherwise
 * any signed-in user could have the server fetch an arbitrary https URL. The
 * check runs in its own tenant transaction, which closes before the caller
 * does any network I/O.
 */
async function requireJiraProjectAdmin(ctx: AuthContext, projectId: string): Promise<void> {
  await withAuthorizedTenant(ctx, (tx) => requireProjectAdmin(tx, { ...ctx, projectId }));
}

const checkConnectionSchema = connectionSchema.extend({ projectId: z.string() });

export const checkJiraConnectionFn = createServerFn({ method: "POST" })
  .validator(checkConnectionSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireJiraProjectAdmin(ctx, data.projectId);
    return checkJiraConnection({ baseUrl: baseUrlOf(data.siteUrl), email: data.email, apiToken: data.apiToken });
  });

const listJiraBoardsSchema = connectionSchema.extend({ projectId: z.string(), projectKey: z.string().min(1) });

export const listJiraBoardsFn = createServerFn({ method: "POST" })
  .validator(listJiraBoardsSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireJiraProjectAdmin(ctx, data.projectId);
    return listJiraBoards({ baseUrl: baseUrlOf(data.siteUrl), email: data.email, apiToken: data.apiToken }, data.projectKey);
  });

/**
 * The migration for a project, or null. The cursor is left out (it holds the
 * runner's large prepared state); `progress` carries what the UI needs.
 * `targets` is what the mapping dropdowns offer, and `latestRun` the newest
 * import run this migration started. Non-admins can read this too.
 */
export const getJiraMigrationFn = createServerFn({ method: "GET" })
  .validator((projectId: string) => projectId)
  .handler(async ({ data: projectId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      await requireProjectAccess(tx, { ...ctx, projectId });
      const row = await getJiraMigrationForProject(tx, projectId);
      if (!row) return { migration: null, targets: null, latestRun: null, runs: [], projectRef: null };
      const { cursor: _cursor, ...migration } = row;
      const targets = await listJiraMappingTargets(tx, projectId, row.boardId);
      const latestRun = await getLatestJiraMigrationRun(tx, row.id);
      const runs = await listJiraMigrationRuns(tx, row.id);
      const projectRef = await getJiraProjectRef(tx, projectId);
      return { migration, targets, latestRun, runs, projectRef };
    });
  });

const createJiraMigrationSchema = connectionSchema.extend({
  projectId: z.string(),
  boardId: z.string(),
  jiraProjectKey: z.string().min(1),
  jiraBoardId: z.number().int().nullable().optional(),
});

/** Creates the migration and queues the first scan, in one tenant transaction. */
export const createJiraMigrationFn = createServerFn({ method: "POST" })
  .validator(createJiraMigrationSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      const { migrationId } = await createJiraMigration(tx, ctx, {
        projectId: data.projectId,
        boardId: data.boardId,
        siteUrl: baseUrlOf(data.siteUrl),
        email: data.email,
        apiToken: data.apiToken,
        jiraProjectKey: data.jiraProjectKey,
        jiraBoardId: data.jiraBoardId ?? null,
      });
      await requestJiraDiscovery(tx, ctx, migrationId);
      return { migrationId };
    });
  });

const updateCredentialsSchema = z.object({
  migrationId: z.string(),
  email: z.email().optional(),
  apiToken: z.string().min(1).optional(),
});

export const updateJiraMigrationCredentialsFn = createServerFn({ method: "POST" })
  .validator(updateCredentialsSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) =>
      updateJiraMigrationCredentials(tx, ctx, data.migrationId, { email: data.email, apiToken: data.apiToken }),
    );
    return { ok: true } as const;
  });

const migrationIdSchema = z.object({ migrationId: z.string() });

export const requestJiraDiscoveryFn = createServerFn({ method: "POST" })
  .validator(migrationIdSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => requestJiraDiscovery(tx, ctx, data.migrationId));
    return { ok: true } as const;
  });

/** The mapping is validated in core against this project and board. `mapping` is checked there, not here. */
export const saveJiraMigrationMappingFn = createServerFn({ method: "POST" })
  .validator(z.object({ migrationId: z.string(), mapping: z.unknown() }))
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => saveJiraMigrationMapping(tx, ctx, data.migrationId, data.mapping));
    return { ok: true } as const;
  });

/** The read-only plan a run would apply, from the saved discovery and mapping. */
export const previewJiraMigrationFn = createServerFn({ method: "GET" })
  .validator((migrationId: string) => migrationId)
  .handler(async ({ data: migrationId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      const row = await getJiraMigration(tx, migrationId);
      if (!row) throw new Error("JIRA migration not found");
      await requireProjectAccess(tx, { ...ctx, projectId: row.projectId });
      if (!row.discovery || !row.mapping) throw new Error("Scan JIRA before previewing the migration");
      return previewJiraMigrationPlan(
        tx,
        { organizationId: ctx.organizationId, projectId: row.projectId, boardId: row.boardId },
        row.discovery as unknown as JiraDiscovery,
        row.mapping as unknown as JiraMigrationMapping,
      );
    });
  });

/**
 * Starts a run. Without a mode it's a sync once the migration has finished a run, else a full import. "full" re-reads the
 * whole project (the repair path); "sync" reads only what JIRA changed since the last finished run; "reconcile" compares
 * both sides and changes nothing (synced migrations only). `then: "reconcile"` on a sync runs a reconcile after it.
 */
export const startJiraMigrationRunFn = createServerFn({ method: "POST" })
  .validator(z.object({ migrationId: z.string(), mode: z.enum(["full", "sync", "reconcile"]).optional(), then: z.literal("reconcile").optional() }))
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => startJiraMigrationRun(tx, ctx, data.migrationId, { mode: data.mode, then: data.then }));
  });

/** The auto-sync interval in minutes (15, 60 or 240), or null to turn it off. */
export const setJiraMigrationAutoSyncFn = createServerFn({ method: "POST" })
  .validator(z.object({ migrationId: z.string(), minutes: z.union([z.literal(15), z.literal(60), z.literal(240), z.null()]) }))
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => setJiraMigrationAutoSync(tx, ctx, data.migrationId, data.minutes));
    return { ok: true } as const;
  });

/** Finishes the migration. With unexplained differences in the newest reconcile, the caller must acknowledge them. */
export const finishJiraMigrationFn = createServerFn({ method: "POST" })
  .validator(z.object({ migrationId: z.string(), acknowledgedDifferences: z.boolean().optional() }))
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => finishJiraMigration(tx, ctx, data.migrationId, { acknowledgedDifferences: data.acknowledgedDifferences }));
    return { ok: true } as const;
  });

/**
 * The newest completed reconcile, in full (every difference), with the Kompast key number of each JIRA key the
 * differences name (for the Kompast links). Null when none has run. Any member who can see the project may read it.
 */
export const getJiraReconcileFn = createServerFn({ method: "GET" })
  .validator(migrationIdSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      const row = await getJiraMigration(tx, data.migrationId);
      if (!row) throw new Error("JIRA migration not found");
      await requireProjectAccess(tx, { ...ctx, projectId: row.projectId });
      const run = await getLatestJiraReconcile(tx, row.id);
      if (!run) return null;
      const notes = (run.notes ?? { differences: [], truncated: 0, clean: true }) as { differences?: { issueKey: string }[] };
      const keySeqs = await jiraKeySeqsOf(tx, row.projectId, [...new Set((notes.differences ?? []).map((d) => d.issueKey))]);
      return {
        id: run.id,
        completedAt: run.completedAt,
        counts: run.counts as Record<string, { jira: number; kompast: number; matched: number; explained: number; unexplained: number }>,
        notes: notes as { differences: { category: string; issueKey: string; jira: string | number | null; kompast: string | number | null; reason: string; detail?: string }[]; truncated: number; clean: boolean },
        keySeqs,
      };
    });
  });

/**
 * The project's files still in JIRA (not copied, queued or failed), for the CSV the run panel downloads.
 * Like getJiraMigrationFn, any member who can see the project may read it.
 */
export const listJiraAttachmentsLeftFn = createServerFn({ method: "GET" })
  .validator((projectId: string) => projectId)
  .handler(async ({ data: projectId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => listAttachmentsLeftInJira(tx, ctx, projectId));
  });

export const deleteJiraMigrationFn = createServerFn({ method: "POST" })
  .validator(migrationIdSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => deleteJiraMigration(tx, ctx, data.migrationId));
    return { ok: true } as const;
  });
