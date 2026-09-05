import { and, eq, schema, sql, type Json } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

export const ISSUE_PROPERTY_TYPES = [
  "text",
  "textarea",
  "number",
  "date",
  "checkbox",
  "select",
  "multiSelect",
  "url",
  "person",
] as const;
export type IssuePropertyType = (typeof ISSUE_PROPERTY_TYPES)[number];

const RESERVED_KEYS = new Set(["jira"]); // packages/import's JIRA importer already writes issue.customFields.jira.*

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "property";
}

export async function listIssuePropertyDefinitions(tx: Tx, projectId: string) {
  return tx
    .select()
    .from(schema.issuePropertyDefinition)
    .where(eq(schema.issuePropertyDefinition.projectId, projectId))
    .orderBy(schema.issuePropertyDefinition.order);
}

export interface CreateIssuePropertyDefinitionInput {
  projectId: string;
  name: string;
  type: IssuePropertyType;
  options?: Json;
  visibleOnCard?: boolean;
}

export async function createIssuePropertyDefinition(
  tx: Tx,
  input: CreateIssuePropertyDefinitionInput,
): Promise<{ definitionId: string; key: string }> {
  if ((input.type === "select" || input.type === "multiSelect") && (!input.options || !Array.isArray(input.options) || input.options.length === 0)) {
    throw new Error(`Property type "${input.type}" requires at least one option`);
  }

  const existing = await tx
    .select({ key: schema.issuePropertyDefinition.key })
    .from(schema.issuePropertyDefinition)
    .where(eq(schema.issuePropertyDefinition.projectId, input.projectId));
  const existingKeys = new Set(existing.map((r) => r.key));

  const baseKey = slugify(input.name);
  let key = baseKey;
  let suffix = 2;
  // Reserved words and existing collisions get a friendlier numeric-suffix
  // disambiguation rather than forcing the user to pick a non-colliding
  // name themselves.
  while (RESERVED_KEYS.has(key) || existingKeys.has(key)) {
    key = `${baseKey}_${suffix}`;
    suffix += 1;
  }

  const [row] = await tx
    .select({ nextOrder: sql<number>`coalesce(max(${schema.issuePropertyDefinition.order}), -1) + 1` })
    .from(schema.issuePropertyDefinition)
    .where(eq(schema.issuePropertyDefinition.projectId, input.projectId));
  const nextOrder = row!.nextOrder;

  const definitionId = id("iprop");
  await tx.insert(schema.issuePropertyDefinition).values({
    id: definitionId,
    projectId: input.projectId,
    key,
    name: input.name,
    type: input.type,
    options: input.options ?? null,
    visibleOnCard: input.visibleOnCard ?? false,
    order: nextOrder,
  });

  return { definitionId, key };
}

export interface UpdateIssuePropertyDefinitionInput {
  projectId: string;
  definitionId: string;
  name?: string;
  type?: IssuePropertyType;
  options?: Json | null;
  visibleOnCard?: boolean;
}

/** Never touches `key` — renaming only changes the user-facing label, never the jsonb key issue.customFields values are stored under. */
export async function updateIssuePropertyDefinition(tx: Tx, input: UpdateIssuePropertyDefinitionInput): Promise<void> {
  const set: Partial<{ name: string; type: IssuePropertyType; options: Json | null; visibleOnCard: boolean; updatedAt: Date }> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) set.name = input.name;
  if (input.type !== undefined) set.type = input.type;
  if (input.options !== undefined) set.options = input.options;
  if (input.visibleOnCard !== undefined) set.visibleOnCard = input.visibleOnCard;

  const result = await tx
    .update(schema.issuePropertyDefinition)
    .set(set)
    .where(and(eq(schema.issuePropertyDefinition.id, input.definitionId), eq(schema.issuePropertyDefinition.projectId, input.projectId)))
    .returning({ id: schema.issuePropertyDefinition.id });
  if (result.length === 0) {
    throw new Error(`Property ${input.definitionId} not found in project ${input.projectId}`);
  }
}

export interface DeleteIssuePropertyDefinitionInput {
  projectId: string;
  definitionId: string;
}

/**
 * Deletes only the definition row — deliberately does NOT scrub the now-
 * orphaned jsonb key out of every issue.customFields row that used it. An
 * orphaned key is harmless: nothing reads a key with no matching
 * definition once the UI only ever iterates definitions, and the GIN index
 * doesn't care either way. Cheap and intentional, not an oversight.
 */
export async function deleteIssuePropertyDefinition(tx: Tx, input: DeleteIssuePropertyDefinitionInput): Promise<void> {
  const [existing] = await tx
    .select({ isCore: schema.issuePropertyDefinition.isCore })
    .from(schema.issuePropertyDefinition)
    .where(and(eq(schema.issuePropertyDefinition.id, input.definitionId), eq(schema.issuePropertyDefinition.projectId, input.projectId)))
    .limit(1);
  if (!existing) throw new Error(`Property ${input.definitionId} not found in project ${input.projectId}`);
  if (existing.isCore) throw new Error("Core properties cannot be deleted — rename or hide them instead");

  await tx.delete(schema.issuePropertyDefinition).where(eq(schema.issuePropertyDefinition.id, input.definitionId));
}
