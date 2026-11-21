import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, sql, and } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { createIssue } from "../issue";
import { getEmbeddingStatus, retryFailedReindexTasks, retryWaitingReindexTasksNow } from "../rag";
import { redactSecret } from "../settings";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

/**
 * Fixture ids are namespaced to this file ("embstat-…"). Other files run in
 * parallel against the same Postgres, so nothing here reads or writes rows
 * outside these two organizations. The embedding queue is system-wide, so
 * every assertion is scoped by organization_id.
 *
 * Queue and embedding rows are inserted directly through the admin
 * connection, not through the mutations that would enqueue them. Ages and
 * claim times use SQL `now() - interval`, so the timestamp arithmetic runs
 * in the database rather than through JS timezone handling.
 */
describe("getEmbeddingStatus / retryFailedReindexTasks", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL!, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "embstat-org";
  const otherOrgId = "embstat-other-org";
  const userId = "embstat-user";
  const teamId = "embstat-team";
  const vector = new Array(schema.EMBEDDING_DIMENSIONS).fill(0);

  async function cleanup() {
    for (const org of [orgId, otherOrgId]) {
      await admin.delete(schema.embeddingIndexQueue).where(eq(schema.embeddingIndexQueue.organizationId, org));
      await admin.delete(schema.embedding).where(eq(schema.embedding.organizationId, org));
      await admin.delete(schema.page).where(eq(schema.page.organizationId, org));
      await admin.delete(schema.issue).where(eq(schema.issue.organizationId, org));
      await admin.delete(schema.project).where(eq(schema.project.organizationId, org));
      await admin.delete(schema.team).where(eq(schema.team.organizationId, org));
      await admin.delete(schema.member).where(eq(schema.member.organizationId, org));
      await admin.delete(schema.organization).where(eq(schema.organization.id, org));
    }
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values([
      { id: orgId, name: "Embedding Status Org", slug: orgId },
      { id: otherOrgId, name: "Embedding Status Other Org", slug: otherOrgId },
    ]);
    await admin.insert(schema.user).values({ id: userId, name: "Status User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "owner" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Status Team" });
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  /** Three issues, two comments on the first, two workspace pages. createIssue enqueues reindex work, so the queue is cleared afterwards and every queue row is then controlled by the test. */
  async function seedContent() {
    const ctx = { userId, organizationId: orgId };
    const issueIds = await withAuthorizedTenant(ctx, async (tx) => {
      const { projectId, issueTypes, statuses } = await createProject(tx, { organizationId: orgId, teamId, key: "est", name: "Status", actorUserId: userId });
      const ids: string[] = [];
      for (const title of ["First", "Second", "Third"]) {
        const { issueId } = await createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title, reporterId: userId });
        ids.push(issueId);
      }
      return ids;
    });
    await admin.delete(schema.embeddingIndexQueue).where(eq(schema.embeddingIndexQueue.organizationId, orgId));

    const [commentA, commentB] = [id("cmt"), id("cmt")];
    await admin.insert(schema.issueComment).values([
      { id: commentA, issueId: issueIds[0]!, authorId: userId, bodyJson: {} },
      { id: commentB, issueId: issueIds[1]!, authorId: userId, bodyJson: {} },
    ]);
    const pageIds = [id("page"), id("page")];
    await admin.insert(schema.page).values([
      { id: pageIds[0]!, organizationId: orgId, title: "Doc A", rank: "a0" },
      { id: pageIds[1]!, organizationId: orgId, title: "Doc B", rank: "a1" },
    ]);
    return { issueIds, commentIds: [commentA, commentB], pageIds };
  }

  it("counts indexed entities distinctly against the workspace totals", async () => {
    const { issueIds, commentIds, pageIds } = await seedContent();
    // Issue 0 has two chunks, so it must count once. Issue 1 has one chunk. Issue 2 is not indexed yet.
    await admin.insert(schema.embedding).values([
      { id: id("emb"), organizationId: orgId, entityType: "issue", entityId: issueIds[0]!, chunkIndex: 0, content: "a", vector },
      { id: id("emb"), organizationId: orgId, entityType: "issue", entityId: issueIds[0]!, chunkIndex: 1, content: "b", vector },
      { id: id("emb"), organizationId: orgId, entityType: "issue", entityId: issueIds[1]!, chunkIndex: 0, content: "c", vector },
      { id: id("emb"), organizationId: orgId, entityType: "comment", entityId: commentIds[0]!, chunkIndex: 0, content: "d", vector },
      { id: id("emb"), organizationId: orgId, entityType: "page", entityId: pageIds[0]!, chunkIndex: 0, content: "e", vector },
    ]);

    const status = await getEmbeddingStatus(admin as never, orgId);

    expect(status.indexed.issue).toEqual({ indexed: 2, total: 3 });
    expect(status.indexed.comment).toEqual({ indexed: 1, total: 2 });
    expect(status.indexed.page).toEqual({ indexed: 1, total: 2 });
    expect(typeof status.configured).toBe("boolean");
  });

  it("counts queue rows by status and reports the age of the oldest pending task", async () => {
    await seedContent();
    await admin.insert(schema.embeddingIndexQueue).values([
      { id: id("ridx"), organizationId: orgId, entityType: "issue", entityId: "embstat-e1", action: "index", status: "pending", createdAt: sql`now() - interval '3 minutes'` },
      { id: id("ridx"), organizationId: orgId, entityType: "issue", entityId: "embstat-e2", action: "index", status: "pending" },
      { id: id("ridx"), organizationId: orgId, entityType: "comment", entityId: "embstat-e3", action: "index", status: "processing" },
      { id: id("ridx"), organizationId: orgId, entityType: "page", entityId: "embstat-e4", action: "index", status: "processed" },
    ]);

    const { queue } = await getEmbeddingStatus(admin as never, orgId);

    expect(queue.pending).toBe(2);
    expect(queue.processing).toBe(1);
    expect(queue.failed).toBe(0);
    // Inserted three minutes ago in SQL, so the age is about 180 seconds (wide bounds for test-run latency).
    expect(queue.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(170);
    expect(queue.oldestPendingAgeSeconds).toBeLessThan(400);
  });

  it("returns the last 10 failures of this workspace, newest first, with trimmed errors", async () => {
    await seedContent();
    const failed = (entityId: string, minutesAgo: number, error: string) => ({
      id: id("ridx"),
      organizationId: orgId,
      entityType: "issue" as const,
      entityId,
      action: "index" as const,
      status: "failed" as const,
      attempts: 5,
      error,
      claimedAt: sql`now() - ${`${minutesAgo} minutes`}::interval`,
    });
    const rows = [failed("embstat-old", 60, "oldest"), failed("embstat-new", 5, "newest"), failed("embstat-mid", 20, "middle")];
    for (let i = 0; i < 9; i += 1) rows.push(failed(`embstat-fill-${i}`, 100 + i, `filler ${i}`));
    rows.push(failed("embstat-long", 1, "x".repeat(900)));
    await admin.insert(schema.embeddingIndexQueue).values(rows);
    // A failure in the other workspace must never appear here.
    await admin.insert(schema.embeddingIndexQueue).values({ id: id("ridx"), organizationId: otherOrgId, entityType: "issue", entityId: "embstat-foreign", action: "index", status: "failed", error: "foreign" });

    const { queue, recentFailures } = await getEmbeddingStatus(admin as never, orgId);

    expect(queue.failed).toBe(13);
    expect(recentFailures).toHaveLength(10);
    expect(recentFailures.map((f) => f.entityId)).toEqual(["embstat-long", "embstat-new", "embstat-mid", "embstat-old", ...Array.from({ length: 6 }, (_, i) => `embstat-fill-${i}`)]);
    expect(recentFailures.find((f) => f.entityId === "embstat-long")!.error).toHaveLength(500);
    expect(recentFailures.find((f) => f.entityId === "embstat-new")).toMatchObject({ attempts: 5, error: "newest", entityType: "issue" });
    expect(recentFailures.some((f) => f.entityId === "embstat-foreign")).toBe(false);
  });

  it("retry resets only this workspace's failed rows, and leaves other states and workspaces alone", async () => {
    await seedContent();
    await admin.insert(schema.embeddingIndexQueue).values([
      { id: "ridx_embstat_f1", organizationId: orgId, entityType: "issue", entityId: "embstat-f1", action: "index", status: "failed", attempts: 5, error: "boom" },
      { id: "ridx_embstat_f2", organizationId: orgId, entityType: "page", entityId: "embstat-f2", action: "index", status: "failed", attempts: 5, error: "bang" },
      { id: "ridx_embstat_p1", organizationId: orgId, entityType: "issue", entityId: "embstat-p1", action: "index", status: "processing", attempts: 1 },
      { id: "ridx_embstat_foreign", organizationId: otherOrgId, entityType: "issue", entityId: "embstat-foreign-f", action: "index", status: "failed", attempts: 5, error: "other org" },
    ]);

    const reset = await retryFailedReindexTasks(admin as never, orgId);

    expect(reset).toBe(2);
    const rows = await admin.select().from(schema.embeddingIndexQueue).where(eq(schema.embeddingIndexQueue.organizationId, orgId));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["ridx_embstat_f1"]).toMatchObject({ status: "pending", attempts: 0, error: null });
    expect(byId["ridx_embstat_f2"]).toMatchObject({ status: "pending", attempts: 0, error: null });
    expect(byId["ridx_embstat_p1"]).toMatchObject({ status: "processing", attempts: 1 });

    const [foreign] = await admin
      .select()
      .from(schema.embeddingIndexQueue)
      .where(and(eq(schema.embeddingIndexQueue.organizationId, otherOrgId), eq(schema.embeddingIndexQueue.id, "ridx_embstat_foreign")));
    expect(foreign).toMatchObject({ status: "failed", attempts: 5, error: "other org" });

    // Nothing left to reset: the second call is a no-op.
    expect(await retryFailedReindexTasks(admin as never, orgId)).toBe(0);
  });

  const queued = (over: Record<string, unknown>) => ({ id: id("ridx"), organizationId: orgId, entityType: "issue" as const, entityId: `embstat-${id("x")}`, action: "index" as const, status: "pending" as const, ...over });

  it("lists pending tasks in retry backoff, soonest first, with their last error", async () => {
    await seedContent();
    await admin.insert(schema.embeddingIndexQueue).values([
      // attempts 1 → 2 min backoff, last failed 1 min ago → next try in ~1 min.
      queued({ entityId: "embstat-r1", attempts: 1, error: "rate limited", claimedAt: sql`now() - interval '1 minute'` }),
      // attempts 3 → 8 min backoff, last failed 1 min ago → next try in ~7 min.
      queued({ entityId: "embstat-r3", attempts: 3, error: "bad dims", claimedAt: sql`now() - interval '1 minute'` }),
      // Never failed: pending, but not a retry.
      queued({ entityId: "embstat-fresh" }),
      queued({ organizationId: otherOrgId, entityId: "embstat-foreign-r", attempts: 2, error: "foreign", claimedAt: sql`now()` }),
    ]);

    const { queue, recentRetries } = await getEmbeddingStatus(admin as never, orgId);

    expect(queue.pending).toBe(3);
    expect(queue.waitingRetry).toBe(2);
    expect(queue.maxAttempts).toBe(5);
    expect(recentRetries.map((r) => r.entityId)).toEqual(["embstat-r1", "embstat-r3"]);
    expect(recentRetries[0]).toMatchObject({ attempts: 1, error: "rate limited", entityType: "issue" });
    expect(recentRetries[0]!.nextAttemptInSeconds).toBeGreaterThan(30);
    expect(recentRetries[0]!.nextAttemptInSeconds).toBeLessThanOrEqual(60);
    expect(recentRetries[1]!.nextAttemptInSeconds).toBeGreaterThan(360);
    expect(recentRetries[1]!.nextAttemptInSeconds).toBeLessThanOrEqual(420);
  });

  it("flags a stalled worker only when ready tasks wait and nothing was claimed in this workspace", async () => {
    await seedContent();
    // Fresh task, last claim long ago: ready for only seconds, so not stalled yet.
    await admin.insert(schema.embeddingIndexQueue).values([
      queued({ entityId: "embstat-new" }),
      queued({ entityId: "embstat-done", status: "processed", claimedAt: sql`now() - interval '1 hour'` }),
    ]);
    let { queue } = await getEmbeddingStatus(admin as never, orgId);
    expect(queue.workerStalled).toBe(false);

    // A task ready for 5 minutes with no claim in an hour: stalled.
    await admin.insert(schema.embeddingIndexQueue).values(queued({ entityId: "embstat-old", createdAt: sql`now() - interval '5 minutes'` }));
    ({ queue } = await getEmbeddingStatus(admin as never, orgId));
    expect(queue.workerStalled).toBe(true);
    expect(queue.oldestReadyAgeSeconds).toBeGreaterThanOrEqual(290);
    expect(queue.lastClaimAgeSeconds).toBeGreaterThanOrEqual(3590);

    // A recent claim in this workspace means the worker is alive (just busy).
    await admin.insert(schema.embeddingIndexQueue).values(queued({ entityId: "embstat-busy", status: "processing", claimedAt: sql`now() - interval '5 seconds'` }));
    ({ queue } = await getEmbeddingStatus(admin as never, orgId));
    expect(queue.workerStalled).toBe(false);
  });

  it("does not count a task still in backoff as stalled work", async () => {
    await seedContent();
    // Created long ago, but failed 1 min ago with a 16 min backoff: not ready, so not stalled.
    await admin.insert(schema.embeddingIndexQueue).values(
      queued({ entityId: "embstat-backoff", attempts: 4, error: "x", createdAt: sql`now() - interval '1 hour'`, claimedAt: sql`now() - interval '1 minute'` }),
    );
    const { queue } = await getEmbeddingStatus(admin as never, orgId);
    expect(queue.oldestReadyAgeSeconds).toBeNull();
    expect(queue.workerStalled).toBe(false);
  });

  it("retry-now makes this workspace's backoff tasks claimable immediately, keeping their attempts", async () => {
    await seedContent();
    await admin.insert(schema.embeddingIndexQueue).values([
      queued({ id: "ridx_embstat_w1", entityId: "embstat-w1", attempts: 4, error: "boom", claimedAt: sql`now() - interval '1 minute'` }),
      queued({ id: "ridx_embstat_w2", entityId: "embstat-w2", attempts: 1, error: "bang", claimedAt: sql`now()` }),
      queued({ id: "ridx_embstat_wf", organizationId: otherOrgId, entityId: "embstat-foreign-w", attempts: 2, error: "other org", claimedAt: sql`now()` }),
    ]);

    expect(await retryWaitingReindexTasksNow(admin as never, orgId)).toBe(2);

    const { queue, recentRetries } = await getEmbeddingStatus(admin as never, orgId);
    expect(recentRetries.every((r) => r.nextAttemptInSeconds === 0)).toBe(true);
    expect(recentRetries.find((r) => r.entityId === "embstat-w1")).toMatchObject({ attempts: 4, error: "boom" });
    // Ready "now", so the panel must not read this as a stalled worker.
    expect(queue.oldestReadyAgeSeconds).toBeLessThan(30);
    expect(queue.workerStalled).toBe(false);

    const [foreign] = await admin.select().from(schema.embeddingIndexQueue).where(eq(schema.embeddingIndexQueue.id, "ridx_embstat_wf"));
    const [stillWaiting] = await admin.execute<{ waiting: boolean }>(
      sql`select claimed_at + make_interval(mins => (2 ^ least(attempts, 6))::int) > now() as waiting from embedding_index_queue where id = ${foreign!.id}`,
    );
    expect(stillWaiting!.waiting).toBe(true);
  });
});

describe("redactSecret", () => {
  it("masks every occurrence of the key and leaves other text alone", () => {
    expect(redactSecret("bad key sk-abc123 echoed, again sk-abc123", "sk-abc123")).toBe("bad key •••• echoed, again ••••");
  });

  it("does nothing for a blank or missing key (splitting on an empty string would corrupt the text)", () => {
    expect(redactSecret("unchanged", "")).toBe("unchanged");
    expect(redactSecret("unchanged", null)).toBe("unchanged");
    expect(redactSecret("unchanged", undefined)).toBe("unchanged");
  });
});
