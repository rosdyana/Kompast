import { and, eq, schema, type Json } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

export class IdempotencyInProgressError extends Error {
  constructor() {
    super("A request with this idempotency key is already in progress");
    this.name = "IdempotencyInProgressError";
  }
}

export type IdempotentClaim = { replayed: true; response: Json } | { replayed: false };

/**
 * Claims (key, endpoint) atomically via the unique index on
 * idempotency_key, BEFORE the caller does any mutation — not a plain
 * check-then-insert, which would let two concurrent requests both pass the
 * check and both create a row. Losing the race means someone else already
 * claimed it: if they've already recorded a response, replay it instead of
 * mutating again; if not (still running), surface that as a 409 rather
 * than either blocking or duplicating.
 */
export async function beginIdempotentRequest(
  tx: Tx,
  organizationId: string,
  endpoint: string,
  key: string,
): Promise<IdempotentClaim> {
  try {
    // A failed INSERT poisons the rest of the enclosing transaction in
    // Postgres (25P02, "current transaction is aborted") unless it runs
    // inside its own savepoint — tx.transaction(...) opens one, so losing
    // the unique-index race here rolls back only the claim attempt, not
    // whatever the caller's own transaction was already doing.
    await tx.transaction(async (savepoint) => {
      await savepoint
        .insert(schema.idempotencyKey)
        .values({ id: id("idem"), organizationId, endpoint, key, responseJson: null });
    });
    return { replayed: false };
  } catch (err) {
    const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
    if (code !== "23505") throw err;

    const [existing] = await tx
      .select({ responseJson: schema.idempotencyKey.responseJson })
      .from(schema.idempotencyKey)
      .where(
        and(
          eq(schema.idempotencyKey.organizationId, organizationId),
          eq(schema.idempotencyKey.endpoint, endpoint),
          eq(schema.idempotencyKey.key, key),
        ),
      );

    if (existing?.responseJson != null) return { replayed: true, response: existing.responseJson };
    throw new IdempotencyInProgressError();
  }
}

export async function commitIdempotentResponse(
  tx: Tx,
  organizationId: string,
  endpoint: string,
  key: string,
  response: Json,
) {
  await tx
    .update(schema.idempotencyKey)
    .set({ responseJson: response })
    .where(
      and(
        eq(schema.idempotencyKey.organizationId, organizationId),
        eq(schema.idempotencyKey.endpoint, endpoint),
        eq(schema.idempotencyKey.key, key),
      ),
    );
}

/**
 * Runs `fn` under idempotency protection within the caller's own
 * transaction: claim the key, run fn, commit its result — all atomic, so a
 * crash between claim and commit leaves the key row response-less
 * (correctly re-claimable, not falsely "already succeeded").
 */
export async function withIdempotency<T extends Json>(
  tx: Tx,
  organizationId: string,
  endpoint: string,
  key: string,
  fn: () => Promise<T>,
): Promise<{ replayed: boolean; response: T }> {
  const claim = await beginIdempotentRequest(tx, organizationId, endpoint, key);
  if (claim.replayed) return { replayed: true, response: claim.response as T };

  const response = await fn();
  await commitIdempotentResponse(tx, organizationId, endpoint, key, response);
  return { replayed: false, response };
}
