import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import {
  createIssuePropertyDefinition,
  deleteIssuePropertyDefinition,
  listIssuePropertyDefinitions,
  requireProjectAccess,
  requireProjectAdmin,
  updateIssuePropertyDefinition,
  withAuthorizedTenant,
} from "@kompast/core";
import { requireAuthContext } from "../session";

/**
 * Duplicated from packages/core/src/issue-property.ts's ISSUE_PROPERTY_TYPES
 * rather than imported — this file's zod schemas run in the client bundle
 * too (createServerFn's .validator() isn't stripped from client output the
 * way .handler() bodies are), and @kompast/core's barrel re-exports
 * everything including packages/db's real Postgres client (`postgres` npm
 * package, which needs Node's Buffer). Importing ANY value from
 * @kompast/core outside a .handler() callback pulls that whole graph into
 * the browser bundle — this is exactly what caused a real "Buffer is not
 * defined" browser error the first time this file did it. Every other
 * server-fn file in this codebase already avoids this by only ever
 * touching @kompast/core inside handlers; match that here, and keep this
 * list in sync by hand with packages/core/src/issue-property.ts's.
 */
const ISSUE_PROPERTY_TYPES = ["text", "textarea", "number", "date", "checkbox", "select", "multiSelect", "url", "person"] as const;

export const listIssuePropertyDefinitionsFn = createServerFn({ method: "GET" })
  .validator((projectId: string) => projectId)
  .handler(async ({ data: projectId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      await requireProjectAccess(tx, { ...ctx, projectId });
      return listIssuePropertyDefinitions(tx, projectId);
    });
  });

const optionsSchema = z.array(z.object({ value: z.string(), label: z.string(), color: z.string().optional() }));

const createIssuePropertyDefinitionSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1),
  type: z.enum(ISSUE_PROPERTY_TYPES),
  options: optionsSchema.optional(),
  visibleOnCard: z.boolean().optional(),
});

export const createIssuePropertyDefinitionFn = createServerFn({ method: "POST" })
  .validator(createIssuePropertyDefinitionSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      await requireProjectAdmin(tx, { ...ctx, projectId: data.projectId });
      return createIssuePropertyDefinition(tx, data);
    });
  });

const updateIssuePropertyDefinitionSchema = z.object({
  projectId: z.string(),
  definitionId: z.string(),
  name: z.string().min(1).optional(),
  type: z.enum(ISSUE_PROPERTY_TYPES).optional(),
  options: optionsSchema.nullable().optional(),
  visibleOnCard: z.boolean().optional(),
});

export const updateIssuePropertyDefinitionFn = createServerFn({ method: "POST" })
  .validator(updateIssuePropertyDefinitionSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, async (tx) => {
      await requireProjectAdmin(tx, { ...ctx, projectId: data.projectId });
      await updateIssuePropertyDefinition(tx, data);
    });
    return { ok: true } as const;
  });

const deleteIssuePropertyDefinitionSchema = z.object({ projectId: z.string(), definitionId: z.string() });

export const deleteIssuePropertyDefinitionFn = createServerFn({ method: "POST" })
  .validator(deleteIssuePropertyDefinitionSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, async (tx) => {
      await requireProjectAdmin(tx, { ...ctx, projectId: data.projectId });
      await deleteIssuePropertyDefinition(tx, data);
    });
    return { ok: true } as const;
  });
