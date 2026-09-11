import { and, eq, schema, sql } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

export interface PriorityLevelSeed {
  key: string;
  name: string;
  color: string;
}

/** Seeded into every newly-created project (packages/core/src/project.ts's createProject). */
export const DEFAULT_PRIORITY_LEVELS: PriorityLevelSeed[] = [
  { key: "very_low", name: "Very Low", color: "var(--text3)" },
  { key: "low", name: "Low", color: "var(--indigo)" },
  { key: "medium", name: "Medium", color: "var(--amber)" },
  { key: "high", name: "High", color: "var(--accent)" },
  { key: "critical", name: "Critical", color: "var(--danger)" },
];

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "priority";
}

export async function listPriorityLevels(tx: Tx, projectId: string) {
  return tx
    .select()
    .from(schema.priorityLevel)
    .where(eq(schema.priorityLevel.projectId, projectId))
    .orderBy(schema.priorityLevel.order);
}

export interface CreatePriorityLevelInput {
  projectId: string;
  name: string;
  color: string;
}

export async function createPriorityLevel(tx: Tx, input: CreatePriorityLevelInput): Promise<{ levelId: string; key: string }> {
  const existing = await tx
    .select({ key: schema.priorityLevel.key })
    .from(schema.priorityLevel)
    .where(eq(schema.priorityLevel.projectId, input.projectId));
  const existingKeys = new Set(existing.map((r) => r.key));

  const baseKey = slugify(input.name);
  let key = baseKey;
  let suffix = 2;
  while (existingKeys.has(key)) {
    key = `${baseKey}_${suffix}`;
    suffix += 1;
  }

  const [row] = await tx
    .select({ nextOrder: sql<number>`coalesce(max(${schema.priorityLevel.order}), -1) + 1` })
    .from(schema.priorityLevel)
    .where(eq(schema.priorityLevel.projectId, input.projectId));
  const nextOrder = row!.nextOrder;

  const levelId = id("prio");
  await tx.insert(schema.priorityLevel).values({
    id: levelId,
    projectId: input.projectId,
    key,
    name: input.name,
    color: input.color,
    order: nextOrder,
  });

  return { levelId, key };
}

export interface UpdatePriorityLevelInput {
  projectId: string;
  levelId: string;
  name?: string;
  color?: string;
  order?: number;
}

/** Never touches `key` — renaming only changes the display label, never the value issue.priority stores. */
export async function updatePriorityLevel(tx: Tx, input: UpdatePriorityLevelInput): Promise<void> {
  const set: Partial<{ name: string; color: string; order: number }> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.color !== undefined) set.color = input.color;
  if (input.order !== undefined) set.order = input.order;

  const result = await tx
    .update(schema.priorityLevel)
    .set(set)
    .where(and(eq(schema.priorityLevel.id, input.levelId), eq(schema.priorityLevel.projectId, input.projectId)))
    .returning({ id: schema.priorityLevel.id });
  if (result.length === 0) {
    throw new Error(`Priority level ${input.levelId} not found in project ${input.projectId}`);
  }
}

export interface ReorderPriorityLevelsInput {
  projectId: string;
  /** Full new order for every priority level in this project; must include exactly the project's current level-id set. */
  orderedLevelIds: string[];
}

export async function reorderPriorityLevels(tx: Tx, input: ReorderPriorityLevelsInput): Promise<void> {
  const levels = await tx
    .select({ id: schema.priorityLevel.id })
    .from(schema.priorityLevel)
    .where(eq(schema.priorityLevel.projectId, input.projectId));

  const currentIds = new Set(levels.map((l) => l.id));
  const requestedIds = new Set(input.orderedLevelIds);
  if (currentIds.size !== requestedIds.size || [...currentIds].some((id) => !requestedIds.has(id))) {
    throw new Error("orderedLevelIds must include exactly the project's current priority levels, no more and no less");
  }

  for (const [index, levelId] of input.orderedLevelIds.entries()) {
    await tx.update(schema.priorityLevel).set({ order: index }).where(eq(schema.priorityLevel.id, levelId));
  }
}

export interface DeletePriorityLevelInput {
  projectId: string;
  levelId: string;
}

/**
 * Blocks deletion if any issue in the project currently uses this level's
 * key, or if it's the project's last remaining level — unlike
 * issue_property_definition (which deliberately allows orphaning inert
 * jsonb keys), issue.priority is actively read/rendered/sorted everywhere,
 * so an orphaned key would break the priority dropdown and board card
 * coloring for every issue that has it.
 */
export async function deletePriorityLevel(tx: Tx, input: DeletePriorityLevelInput): Promise<void> {
  const [level] = await tx
    .select({ id: schema.priorityLevel.id, key: schema.priorityLevel.key })
    .from(schema.priorityLevel)
    .where(and(eq(schema.priorityLevel.id, input.levelId), eq(schema.priorityLevel.projectId, input.projectId)))
    .limit(1);
  if (!level) throw new Error(`Priority level ${input.levelId} not found in project ${input.projectId}`);

  const remaining = await tx
    .select({ id: schema.priorityLevel.id })
    .from(schema.priorityLevel)
    .where(eq(schema.priorityLevel.projectId, input.projectId));
  if (remaining.length <= 1) throw new Error("Cannot delete the last remaining priority level");

  const [inUse] = await tx
    .select({ id: schema.issue.id })
    .from(schema.issue)
    .where(and(eq(schema.issue.projectId, input.projectId), eq(schema.issue.priority, level.key)))
    .limit(1);
  if (inUse) throw new Error(`Priority level "${level.key}" is still in use by at least one issue`);

  await tx.delete(schema.priorityLevel).where(eq(schema.priorityLevel.id, input.levelId));
}
