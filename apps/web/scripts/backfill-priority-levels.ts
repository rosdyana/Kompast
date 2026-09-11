import { and, eq, schema } from "@kompast/db";
import { adminDb } from "@kompast/db";
import { createPriorityLevel, withAuthorizedTenant } from "@kompast/core";

const DEFAULT_LEVELS: { name: string; color: string }[] = [
  { name: "Lowest", color: "var(--text-3)" },
  { name: "Low", color: "var(--text-3)" },
  { name: "Medium", color: "var(--text-3)" },
  { name: "High", color: "var(--amber)" },
  { name: "Highest", color: "var(--danger)" },
];

async function findAnyMember(organizationId: string): Promise<string | null> {
  const [row] = await adminDb
    .select({ userId: schema.member.userId })
    .from(schema.member)
    .where(eq(schema.member.organizationId, organizationId))
    .limit(1);
  return row?.userId ?? null;
}

/**
 * One-time backfill: seeds the 5 pre-existing hardcoded priority values
 * (lowest/low/medium/high/highest — matching what's already stored on
 * every existing issue.priority, NOT the new-project DEFAULT_PRIORITY_LEVELS
 * naming) as real priority_level rows, for every project that doesn't
 * already have any. Idempotent — safe to re-run; skips any project that
 * already has at least one priority_level row.
 */
async function main() {
  const projects = await adminDb.select({ id: schema.project.id, key: schema.project.key, organizationId: schema.project.organizationId }).from(schema.project);

  let seeded = 0;
  let skipped = 0;

  for (const project of projects) {
    const [existing] = await adminDb.select({ id: schema.priorityLevel.id }).from(schema.priorityLevel).where(eq(schema.priorityLevel.projectId, project.id)).limit(1);
    if (existing) {
      skipped++;
      continue;
    }

    const memberUserId = await findAnyMember(project.organizationId);
    if (!memberUserId) {
      console.warn(`skipping project ${project.key} (${project.id}) — no organization member found`);
      continue;
    }

    await withAuthorizedTenant({ userId: memberUserId, organizationId: project.organizationId }, async (tx) => {
      // Sequential, not Promise.all — createPriorityLevel computes each
      // row's `order` from a live max() query, so concurrent calls within
      // the same transaction would race on that computation.
      for (const level of DEFAULT_LEVELS) {
        await createPriorityLevel(tx, { projectId: project.id, name: level.name, color: level.color });
      }
    });

    console.log(`seeded ${DEFAULT_LEVELS.length} priority levels for project ${project.key} (${project.id})`);
    seeded++;
  }

  console.log(`done: ${seeded} project(s) seeded, ${skipped} already had priority levels`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
