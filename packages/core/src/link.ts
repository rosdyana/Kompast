import { and, eq, schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

export type LinkableType = "page" | "issue";

export interface LinkEntitiesInput {
  organizationId: string;
  fromType: LinkableType;
  fromId: string;
  toType: LinkableType;
  toId: string;
  kind?: "reference" | "mention";
  createdBy?: string;
}

/** Idempotent by (fromType, fromId, toType, toId, kind) — linking twice is a no-op, not a duplicate row. */
export async function linkEntities(tx: Tx, input: LinkEntitiesInput) {
  const kind = input.kind ?? "reference";
  const [existing] = await tx
    .select({ id: schema.link.id })
    .from(schema.link)
    .where(
      and(
        eq(schema.link.fromType, input.fromType),
        eq(schema.link.fromId, input.fromId),
        eq(schema.link.toType, input.toType),
        eq(schema.link.toId, input.toId),
        eq(schema.link.kind, kind),
      ),
    );
  if (existing) return existing.id;

  const linkId = id("link");
  await tx.insert(schema.link).values({
    id: linkId,
    organizationId: input.organizationId,
    fromType: input.fromType,
    fromId: input.fromId,
    toType: input.toType,
    toId: input.toId,
    kind,
    createdBy: input.createdBy,
  });
  return linkId;
}

export async function unlinkEntities(
  tx: Tx,
  input: { fromType: LinkableType; fromId: string; toType: LinkableType; toId: string; kind?: "reference" | "mention" },
) {
  await tx
    .delete(schema.link)
    .where(
      and(
        eq(schema.link.fromType, input.fromType),
        eq(schema.link.fromId, input.fromId),
        eq(schema.link.toType, input.toType),
        eq(schema.link.toId, input.toId),
        eq(schema.link.kind, input.kind ?? "reference"),
      ),
    );
}

/** Everything a given entity explicitly links out to (either direction of "reference", not mentions). */
export async function listOutgoingLinks(tx: Tx, fromType: LinkableType, fromId: string) {
  return tx
    .select()
    .from(schema.link)
    .where(and(eq(schema.link.fromType, fromType), eq(schema.link.fromId, fromId), eq(schema.link.kind, "reference")));
}

/** Everything that points AT this entity — explicit links and inline @mentions alike. Powers the backlinks panel. */
export async function listBacklinks(tx: Tx, toType: LinkableType, toId: string) {
  return tx.select().from(schema.link).where(and(eq(schema.link.toType, toType), eq(schema.link.toId, toId)));
}

/**
 * Reconciles the mention set found in a page's current content against
 * `link` rows of kind='mention': inserts newly-appearing mentions, removes
 * ones no longer present. Called by apps/collab after every debounced
 * store, so backlinks always match the actual document instead of only
 * ever growing.
 */
export async function syncPageMentions(
  tx: Tx,
  organizationId: string,
  pageId: string,
  mentions: Array<{ type: LinkableType; id: string }>,
) {
  const current = await tx
    .select()
    .from(schema.link)
    .where(and(eq(schema.link.fromType, "page"), eq(schema.link.fromId, pageId), eq(schema.link.kind, "mention")));

  const wanted = new Set(mentions.map((m) => `${m.type}:${m.id}`));
  const existing = new Set(current.map((l) => `${l.toType}:${l.toId}`));

  const toRemove = current.filter((l) => !wanted.has(`${l.toType}:${l.toId}`));
  const toAdd = mentions.filter((m) => !existing.has(`${m.type}:${m.id}`));

  await Promise.all(toRemove.map((l) => tx.delete(schema.link).where(eq(schema.link.id, l.id))));
  await Promise.all(
    toAdd.map((m) =>
      linkEntities(tx, { organizationId, fromType: "page", fromId: pageId, toType: m.type, toId: m.id, kind: "mention" }),
    ),
  );
}
