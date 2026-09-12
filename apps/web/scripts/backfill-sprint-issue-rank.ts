import { asc, eq, isNull, schema } from "@kompast/db";
import { adminDb } from "@kompast/db";
import { rankBetween } from "@kompast/core";

/**
 * One-time backfill: sprint_issue.rank (the Sprint Review table's manual
 * drag-and-drop order — see the schema's doc comment) didn't exist before
 * this migration, so every pre-existing row has rank = null. Assigns
 * sequential fractional ranks per sprint, ordered by addedAt (the closest
 * approximation of "the order they were added in" available for rows that
 * predate manual reordering). Idempotent — only ever touches rows still at
 * rank = null, so a second run is a no-op.
 */
async function main() {
  const unranked = await adminDb
    .select({ id: schema.sprintIssue.id, sprintId: schema.sprintIssue.sprintId, addedAt: schema.sprintIssue.addedAt })
    .from(schema.sprintIssue)
    .where(isNull(schema.sprintIssue.rank))
    .orderBy(asc(schema.sprintIssue.addedAt));

  const bySprintId = new Map<string, typeof unranked>();
  for (const row of unranked) {
    const group = bySprintId.get(row.sprintId) ?? [];
    group.push(row);
    bySprintId.set(row.sprintId, group);
  }

  let updated = 0;
  for (const [sprintId, rows] of bySprintId) {
    let previousRank: string | null = null;
    for (const row of rows) {
      const rank = rankBetween(previousRank, null);
      await adminDb.update(schema.sprintIssue).set({ rank }).where(eq(schema.sprintIssue.id, row.id));
      previousRank = rank;
      updated++;
    }
    console.log(`ranked ${rows.length} sprint_issue row(s) for sprint ${sprintId}`);
  }

  console.log(`done: ${updated} sprint_issue row(s) ranked across ${bySprintId.size} sprint(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
