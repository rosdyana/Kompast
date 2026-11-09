import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminDb as admin, schema, eq, inArray } from "@kompast/db";
import { ForbiddenError, withAuthorizedTenant, type AuthContext } from "../permissions";
import { id } from "../ids";
import {
  claimNotionMigrations,
  createNotionMigration,
  deleteNotionMigration,
  getNotionMigration,
  getNotionMigrationToken,
  listNotionMigrations,
  markNotionMigrationDone,
  markNotionMigrationFailed,
  renewNotionMigrationLease,
  requestNotionDiscovery,
  retryNotionMigration,
  releaseNotionMigrationLease,
  updateNotionMigrationCursor,
  saveNotionDiscovery,
  saveNotionSelection,
  startNotionMigrationRun,
  updateNotionMigrationToken,
} from "../notion-migration";

describe("Notion migration record (core)", () => {
  const orgId = "test-notion-mig-org";
  const creatorId = "test-notion-mig-creator";
  const otherId = "test-notion-mig-other";
  const teamId = "test-notion-mig-team";
  const creatorCtx: AuthContext = { userId: creatorId, organizationId: orgId };
  const otherCtx: AuthContext = { userId: otherId, organizationId: orgId };
  const SECRET = "ntn_notion-secret-token";
  const userIds = [creatorId, otherId];

  async function cleanup() {
    await admin.delete(schema.notionMigration).where(eq(schema.notionMigration.organizationId, orgId));
    await admin.delete(schema.importRun).where(eq(schema.importRun.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(inArray(schema.user.id, userIds));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Notion Migration Test Org", slug: orgId });
    await admin.insert(schema.user).values([
      { id: creatorId, name: "Connector", email: `${creatorId}@example.com` },
      { id: otherId, name: "Other", email: `${otherId}@example.com` },
    ]);
    await admin.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId: creatorId, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: otherId, role: "member" },
    ]);
    // Only the other member is on the team. The creator isn't, so a team target must be refused for them.
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Notion Migration Team" });
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${otherId}`, teamId, userId: otherId, membershipKey: `${teamId}:${otherId}` });
  });

  afterAll(cleanup);

  async function connect(): Promise<string> {
    const { migrationId } = await withAuthorizedTenant(creatorCtx, (tx) => createNotionMigration(tx, creatorCtx, { token: SECRET, workspaceName: "Acme" }));
    return migrationId;
  }

  /** What the worker does after a discovery: store the page tree, which moves the migration to "ready". */
  async function discover(migrationId: string) {
    await withAuthorizedTenant(creatorCtx, (tx) => saveNotionDiscovery(tx, migrationId, { pages: [{ notionId: "p1" }] }, "Acme"));
  }

  const root = (notionId: string, target: unknown) => ({ roots: [{ notionId, title: `Page ${notionId}`, target }] });

  it("stores the token encrypted, shows the row only to its creator, and never returns the token", async () => {
    const migrationId = await connect();

    const [raw] = await admin.select().from(schema.notionMigration).where(eq(schema.notionMigration.id, migrationId));
    expect(raw!.tokenEncrypted).toBeTruthy();
    expect(raw!.tokenEncrypted).not.toContain(SECRET);
    expect(raw).toMatchObject({ state: "discovering", workspaceName: "Acme", createdBy: creatorId });
    expect(await getNotionMigrationToken(admin, migrationId)).toBe(SECRET);

    const view = await withAuthorizedTenant(creatorCtx, (tx) => getNotionMigration(tx, migrationId));
    expect(view).toMatchObject({ id: migrationId, state: "discovering", hasToken: true, workspaceName: "Acme" });
    expect(view).not.toHaveProperty("tokenEncrypted");
    expect(JSON.stringify(view)).not.toContain(SECRET);
    const mine = await withAuthorizedTenant(creatorCtx, (tx) => listNotionMigrations(tx));
    expect(mine.map((m) => m.id)).toContain(migrationId);

    expect(await withAuthorizedTenant(otherCtx, (tx) => getNotionMigration(tx, migrationId))).toBeNull();
    const theirs = await withAuthorizedTenant(otherCtx, (tx) => listNotionMigrations(tx));
    expect(theirs.filter((m) => m.organizationId === orgId)).toHaveLength(0);
    await expect(withAuthorizedTenant(otherCtx, (tx) => updateNotionMigrationToken(tx, otherCtx, migrationId, { token: "x", workspaceName: "" }))).rejects.toThrow(/not found/);
    await expect(withAuthorizedTenant(otherCtx, (tx) => deleteNotionMigration(tx, otherCtx, migrationId))).rejects.toThrow(/not found/);
  });

  it("a selection is validated, and a team target is refused for a caller who is not on that team", async () => {
    const migrationId = await connect();
    await discover(migrationId);
    expect(await withAuthorizedTenant(creatorCtx, (tx) => getNotionMigration(tx, migrationId))).toMatchObject({ state: "ready" });

    await expect(withAuthorizedTenant(creatorCtx, (tx) => saveNotionSelection(tx, creatorCtx, migrationId, root("p1", { team: teamId })))).rejects.toBeInstanceOf(ForbiddenError);
    // A plain member may not import into Workspace docs either (workspace owner/admin only).
    await expect(withAuthorizedTenant(creatorCtx, (tx) => saveNotionSelection(tx, creatorCtx, migrationId, root("p1", "workspace")))).rejects.toBeInstanceOf(ForbiddenError);

    await expect(withAuthorizedTenant(creatorCtx, (tx) => saveNotionSelection(tx, creatorCtx, migrationId, { roots: "nope" }))).rejects.toThrow(/must list/);
    await expect(withAuthorizedTenant(creatorCtx, (tx) => saveNotionSelection(tx, creatorCtx, migrationId, root("p1", "elsewhere")))).rejects.toThrow(/choose Workspace/);
    await expect(
      withAuthorizedTenant(creatorCtx, (tx) =>
        saveNotionSelection(tx, creatorCtx, migrationId, { roots: [{ notionId: "p1", target: "private" }, { notionId: "p1", target: "private" }] }),
      ),
    ).rejects.toThrow(/selected twice/);

    await withAuthorizedTenant(creatorCtx, (tx) => saveNotionSelection(tx, creatorCtx, migrationId, root("p1", "private")));
    const saved = await admin.select().from(schema.notionMigration).where(eq(schema.notionMigration.id, migrationId));
    expect(saved[0]!.selection).toEqual({ roots: [{ notionId: "p1", title: "Page p1", target: "private" }] });

    // Once the creator joins the team, the same team target is accepted, and the selection holds the team as its target.
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${creatorId}`, teamId, userId: creatorId, membershipKey: `${teamId}:${creatorId}` });
    await withAuthorizedTenant(creatorCtx, (tx) => saveNotionSelection(tx, creatorCtx, migrationId, root("p1", { team: teamId })));
    const reSaved = await admin.select().from(schema.notionMigration).where(eq(schema.notionMigration.id, migrationId));
    expect(reSaved[0]!.selection).toEqual({ roots: [{ notionId: "p1", title: "Page p1", target: { team: teamId } }] });
  });

  it("starting a run creates its import_run and moves the migration to running; it can't start twice, and a running token can't change", async () => {
    const migrationId = await connect();
    await discover(migrationId);
    await expect(withAuthorizedTenant(creatorCtx, (tx) => startNotionMigrationRun(tx, creatorCtx, migrationId))).rejects.toThrow(/Select at least one page/);

    await withAuthorizedTenant(creatorCtx, (tx) => saveNotionSelection(tx, creatorCtx, migrationId, root("p1", "private")));
    const { importRunId } = await withAuthorizedTenant(creatorCtx, (tx) => startNotionMigrationRun(tx, creatorCtx, migrationId));

    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
    expect(run).toMatchObject({ source: "notion", status: "running", projectId: null, createdBy: creatorId, config: { via: "api", migrationId } });
    const [row] = await admin.select().from(schema.notionMigration).where(eq(schema.notionMigration.id, migrationId));
    expect(row).toMatchObject({ state: "running", importRunId, cursor: null, error: null });

    await expect(withAuthorizedTenant(creatorCtx, (tx) => startNotionMigrationRun(tx, creatorCtx, migrationId))).rejects.toThrow(/Cannot start/);
    await expect(withAuthorizedTenant(creatorCtx, (tx) => updateNotionMigrationToken(tx, creatorCtx, migrationId, { token: "new", workspaceName: "" }))).rejects.toThrow(
      /Cannot change the token/,
    );
  });

  it("claims leases exclusively, and the row comes back once its lease expires", async () => {
    const migrationId = await connect();
    const first = await claimNotionMigrations(admin, 60_000, [migrationId]);
    const claimed = first.find((m) => m.id === migrationId);
    expect(claimed).toBeDefined();
    expect(claimed).not.toHaveProperty("tokenEncrypted");
    expect(claimed).toMatchObject({ hasToken: true, state: "discovering" });

    expect((await claimNotionMigrations(admin, 60_000, [migrationId])).map((m) => m.id)).not.toContain(migrationId);

    await admin.update(schema.notionMigration).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.notionMigration.id, migrationId));
    expect((await claimNotionMigrations(admin, 60_000, [migrationId])).map((m) => m.id)).toContain(migrationId);
  });

  it("a finished run keeps its token; a failed one can be retried; deletion clears the token and waits for a live lease", async () => {
    const migrationId = await connect();
    await discover(migrationId);
    await withAuthorizedTenant(creatorCtx, (tx) => saveNotionSelection(tx, creatorCtx, migrationId, root("p1", "private")));
    await withAuthorizedTenant(creatorCtx, (tx) => startNotionMigrationRun(tx, creatorCtx, migrationId));

    // A live lease (a worker is copying) blocks deletion.
    await admin.update(schema.notionMigration).set({ leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(schema.notionMigration.id, migrationId));
    await expect(withAuthorizedTenant(creatorCtx, (tx) => deleteNotionMigration(tx, creatorCtx, migrationId))).rejects.toThrow(/Cannot delete/);
    await admin.update(schema.notionMigration).set({ leaseExpiresAt: null }).where(eq(schema.notionMigration.id, migrationId));

    await markNotionMigrationFailed(admin, migrationId, "rate limited");
    const failed = await withAuthorizedTenant(creatorCtx, (tx) => getNotionMigration(tx, migrationId));
    expect(failed).toMatchObject({ state: "failed", error: "rate limited", hasToken: true });

    expect(await withAuthorizedTenant(creatorCtx, (tx) => retryNotionMigration(tx, creatorCtx, migrationId))).toEqual({ state: "ready" });
    await withAuthorizedTenant(creatorCtx, (tx) => startNotionMigrationRun(tx, creatorCtx, migrationId));
    await withAuthorizedTenant(creatorCtx, (tx) => markNotionMigrationDone(tx, migrationId));
    const done = await withAuthorizedTenant(creatorCtx, (tx) => getNotionMigration(tx, migrationId));
    expect(done).toMatchObject({ state: "done", hasToken: true, cursor: null });
    expect(await getNotionMigrationToken(admin, migrationId)).toBe(SECRET);

    // A finished migration can be re-discovered and re-run with the same token.
    await withAuthorizedTenant(creatorCtx, (tx) => requestNotionDiscovery(tx, creatorCtx, migrationId));
    expect(await withAuthorizedTenant(creatorCtx, (tx) => getNotionMigration(tx, migrationId))).toMatchObject({ state: "discovering" });

    await withAuthorizedTenant(creatorCtx, (tx) => deleteNotionMigration(tx, creatorCtx, migrationId));
    expect(await admin.select().from(schema.notionMigration).where(eq(schema.notionMigration.id, migrationId))).toHaveLength(0);
  });

  it("renewing and releasing the worker lease round-trips through the admin connection", async () => {
    const migrationId = await connect();
    expect(await renewNotionMigrationLease(admin, migrationId, null, 60_000)).toBe(true);
    const [held] = await admin.select().from(schema.notionMigration).where(eq(schema.notionMigration.id, migrationId));
    expect(held!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    await releaseNotionMigrationLease(admin, migrationId, null);
    const [released] = await admin.select().from(schema.notionMigration).where(eq(schema.notionMigration.id, migrationId));
    expect(released!.leaseExpiresAt).toBeNull();
  });

  it("a tick whose lease was taken over can't renew, write its cursor, finish, or release the newer lease", async () => {
    const migrationId = await connect();
    const stale = (await claimNotionMigrations(admin, 60_000, [migrationId])).find((m) => m.id === migrationId)!;
    expect(stale.leaseOwner).toBeTruthy();

    // The stale tick ran past its lease, and a second tick claimed the row.
    await admin.update(schema.notionMigration).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.notionMigration.id, migrationId));
    const fresh = (await claimNotionMigrations(admin, 60_000, [migrationId])).find((m) => m.id === migrationId)!;
    expect(fresh.leaseOwner).toBeTruthy();
    expect(fresh.leaseOwner).not.toBe(stale.leaseOwner);

    expect(await renewNotionMigrationLease(admin, migrationId, stale.leaseOwner)).toBe(false);
    expect(await withAuthorizedTenant(creatorCtx, (tx) => updateNotionMigrationCursor(tx, migrationId, { step: "stale" }, {}, stale.leaseOwner))).toBe(false);
    expect(await withAuthorizedTenant(creatorCtx, (tx) => markNotionMigrationDone(tx, migrationId, stale.leaseOwner))).toBe(false);
    expect(await markNotionMigrationFailed(admin, migrationId, "stale", stale.leaseOwner)).toBe(false);
    await releaseNotionMigrationLease(admin, migrationId, stale.leaseOwner);

    const [row] = await admin.select().from(schema.notionMigration).where(eq(schema.notionMigration.id, migrationId));
    expect(row).toMatchObject({ leaseOwner: fresh.leaseOwner, state: "discovering", cursor: null, error: null });
    expect(row!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    // The current holder still can.
    expect(await renewNotionMigrationLease(admin, migrationId, fresh.leaseOwner)).toBe(true);
    expect(await withAuthorizedTenant(creatorCtx, (tx) => updateNotionMigrationCursor(tx, migrationId, { step: "fresh" }, {}, fresh.leaseOwner))).toBe(true);
    await releaseNotionMigrationLease(admin, migrationId, fresh.leaseOwner);
    const [after] = await admin.select().from(schema.notionMigration).where(eq(schema.notionMigration.id, migrationId));
    expect(after).toMatchObject({ leaseExpiresAt: null, leaseOwner: null, cursor: { step: "fresh" } });
  });
});
