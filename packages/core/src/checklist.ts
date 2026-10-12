import { and, asc, desc, eq, gt, inArray, lt, schema, sql } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";
import { rankBetween } from "./rank";

const MAX_ITEM_LENGTH = 500;

function cleanText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Checklist item text is required");
  return trimmed.slice(0, MAX_ITEM_LENGTH);
}

/**
 * Explicit visibility check before any write: the RLS policy would reject
 * an insert for an issue the caller can't see anyway, but as an opaque
 * policy-violation error rather than a readable one.
 */
async function requireVisibleIssue(tx: Tx, issueId: string) {
  const [row] = await tx.select({ id: schema.issue.id }).from(schema.issue).where(eq(schema.issue.id, issueId));
  if (!row) throw new Error(`Issue ${issueId} not found`);
}

async function requireItem(tx: Tx, itemId: string) {
  const [row] = await tx.select().from(schema.issueChecklistItem).where(eq(schema.issueChecklistItem.id, itemId));
  if (!row) throw new Error(`Checklist item ${itemId} not found`);
  return row;
}

export async function listChecklistItems(tx: Tx, issueId: string) {
  return tx
    .select({ id: schema.issueChecklistItem.id, text: schema.issueChecklistItem.text, done: schema.issueChecklistItem.done, rank: schema.issueChecklistItem.rank })
    .from(schema.issueChecklistItem)
    .where(eq(schema.issueChecklistItem.issueId, issueId))
    .orderBy(asc(schema.issueChecklistItem.rank));
}

/** `{ done, total }` per issue that has at least one item — issues with an empty checklist are simply absent. */
export async function getChecklistSummaries(tx: Tx, issueIds: string[]) {
  const summaries = new Map<string, { done: number; total: number }>();
  if (issueIds.length === 0) return summaries;
  const rows = await tx
    .select({
      issueId: schema.issueChecklistItem.issueId,
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${schema.issueChecklistItem.done})::int`,
    })
    .from(schema.issueChecklistItem)
    .where(inArray(schema.issueChecklistItem.issueId, issueIds))
    .groupBy(schema.issueChecklistItem.issueId);
  for (const r of rows) summaries.set(r.issueId, { done: r.done, total: r.total });
  return summaries;
}

/** Appends to the end of the issue's checklist. */
export async function addChecklistItem(tx: Tx, input: { issueId: string; text: string; createdBy: string }) {
  await requireVisibleIssue(tx, input.issueId);
  const [last] = await tx
    .select({ rank: schema.issueChecklistItem.rank })
    .from(schema.issueChecklistItem)
    .where(eq(schema.issueChecklistItem.issueId, input.issueId))
    .orderBy(desc(schema.issueChecklistItem.rank))
    .limit(1);
  const itemId = id("chk");
  const row = { id: itemId, issueId: input.issueId, text: cleanText(input.text), done: false, rank: rankBetween(last?.rank ?? null, null), createdBy: input.createdBy };
  await tx.insert(schema.issueChecklistItem).values(row);
  return { id: row.id, text: row.text, done: row.done, rank: row.rank };
}

export async function updateChecklistItem(tx: Tx, input: { itemId: string; text?: string; done?: boolean }) {
  await requireItem(tx, input.itemId);
  const patch: { text?: string; done?: boolean; updatedAt: Date } = { updatedAt: new Date() };
  if (input.text !== undefined) patch.text = cleanText(input.text);
  if (input.done !== undefined) patch.done = input.done;
  await tx.update(schema.issueChecklistItem).set(patch).where(eq(schema.issueChecklistItem.id, input.itemId));
}

export async function deleteChecklistItem(tx: Tx, itemId: string) {
  await requireItem(tx, itemId);
  await tx.delete(schema.issueChecklistItem).where(eq(schema.issueChecklistItem.id, itemId));
}

/** Swaps an item one slot up or down — a single-row rank write between its new neighbours. */
export async function moveChecklistItem(tx: Tx, input: { itemId: string; direction: "up" | "down" }) {
  const item = await requireItem(tx, input.itemId);
  const t = schema.issueChecklistItem;
  const up = input.direction === "up";
  const neighbours = await tx
    .select({ rank: t.rank })
    .from(t)
    .where(and(eq(t.issueId, item.issueId), up ? lt(t.rank, item.rank) : gt(t.rank, item.rank)))
    .orderBy(up ? desc(t.rank) : asc(t.rank))
    .limit(2);
  if (neighbours.length === 0) return;
  const [near, far] = neighbours;
  const rank = up ? rankBetween(far?.rank ?? null, near!.rank) : rankBetween(near!.rank, far?.rank ?? null);
  await tx.update(t).set({ rank, updatedAt: new Date() }).where(eq(t.id, input.itemId));
}
