import { asc, eq, schema, sql } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

export interface LogWorkInput {
  issueId: string;
  userId: string;
  seconds: number;
  note?: string;
  /** Backdates the entry — for the importer, where a JIRA worklog's real `started` timestamp must be preserved. Omit for a real-time log (defaults to now). */
  loggedAt?: Date;
}

/**
 * Appends a worklog entry and atomically bumps issue.spentSeconds by the
 * same amount — a raw SQL increment rather than routing through
 * updateIssue(), since this is pure accumulation with no from/to value to
 * diff into issue_history the way a field *replacement* would need.
 *
 * Import note: when the source data is a list of individual worklog
 * entries (JIRA's fields.worklog.worklogs[]), call this once per entry so
 * spentSeconds accumulates correctly and each entry's author/timestamp
 * survives — do NOT also set spentSeconds directly via updateIssue for
 * the same issue, or the total double-counts.
 */
export async function logWork(tx: Tx, input: LogWorkInput) {
  const worklogId = id("wlog");
  await tx.insert(schema.worklog).values({
    id: worklogId,
    issueId: input.issueId,
    userId: input.userId,
    seconds: input.seconds,
    note: input.note,
    ...(input.loggedAt ? { loggedAt: input.loggedAt } : {}),
  });

  await tx
    .update(schema.issue)
    .set({ spentSeconds: sql`${schema.issue.spentSeconds} + ${input.seconds}`, updatedAt: new Date() })
    .where(eq(schema.issue.id, input.issueId));

  return { worklogId };
}

export async function listWorklogs(tx: Tx, issueId: string) {
  return tx.select().from(schema.worklog).where(eq(schema.worklog.issueId, issueId)).orderBy(asc(schema.worklog.loggedAt));
}
