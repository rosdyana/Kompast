import { and, eq, schema, type Json } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

export type ImportSourceName = "jira" | "notion";
export type ImportEntityType = "issue" | "page";

export interface CreateImportRunInput {
  organizationId: string;
  projectId: string;
  source: ImportSourceName;
  dryRun: boolean;
  /** Non-secret parameters only (project key, base URL) — never a credential. See packages/db/src/schema/import.ts. */
  config: Json;
  createdBy: string;
}

export async function createImportRun(tx: Tx, input: CreateImportRunInput) {
  const importRunId = id("imprun");
  await tx.insert(schema.importRun).values({
    id: importRunId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    source: input.source,
    dryRun: input.dryRun,
    config: input.config,
    createdBy: input.createdBy,
  });
  return { importRunId };
}

export async function markImportRunRunning(tx: Tx, importRunId: string) {
  await tx.update(schema.importRun).set({ status: "running", startedAt: new Date() }).where(eq(schema.importRun.id, importRunId));
}

export async function completeImportRun(tx: Tx, importRunId: string, counts: Json, errors: Json) {
  await tx.update(schema.importRun).set({ status: "completed", counts, errors, completedAt: new Date() }).where(eq(schema.importRun.id, importRunId));
}

export async function failImportRun(tx: Tx, importRunId: string, error: string) {
  await tx
    .update(schema.importRun)
    .set({ status: "failed", errors: [{ error }], completedAt: new Date() })
    .where(eq(schema.importRun.id, importRunId));
}

export async function getImportRun(tx: Tx, importRunId: string) {
  const [row] = await tx.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
  return row ?? null;
}

export async function listImportRuns(tx: Tx, projectId: string) {
  return tx.select().from(schema.importRun).where(eq(schema.importRun.projectId, projectId));
}

/** Looks up the Kompast row a given external id already became, if this exact (source, sourceId) was seen before — the idempotency check every loader must make before creating anything. */
export async function resolveExternalRef(tx: Tx, organizationId: string, source: ImportSourceName, sourceId: string) {
  const [row] = await tx
    .select()
    .from(schema.externalRef)
    .where(and(eq(schema.externalRef.organizationId, organizationId), eq(schema.externalRef.source, source), eq(schema.externalRef.sourceId, sourceId)));
  return row ?? null;
}

export interface UpsertExternalRefInput {
  organizationId: string;
  source: ImportSourceName;
  sourceId: string;
  sourceUrl?: string;
  entityType: ImportEntityType;
  entityId: string;
  importRunId: string;
}

/** Records (or re-confirms) that `sourceId` maps to `entityId` — the ON CONFLICT is what makes re-running an import idempotent rather than erroring on the second pass. */
export async function upsertExternalRef(tx: Tx, input: UpsertExternalRefInput) {
  await tx
    .insert(schema.externalRef)
    .values({
      id: id("extref"),
      organizationId: input.organizationId,
      source: input.source,
      sourceId: input.sourceId,
      sourceUrl: input.sourceUrl,
      entityType: input.entityType,
      entityId: input.entityId,
      importRunId: input.importRunId,
    })
    .onConflictDoUpdate({
      target: [schema.externalRef.organizationId, schema.externalRef.source, schema.externalRef.sourceId],
      set: { entityId: input.entityId, sourceUrl: input.sourceUrl, importRunId: input.importRunId },
    });
}
