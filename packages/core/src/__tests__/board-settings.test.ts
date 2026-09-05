import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, asc } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { deleteBoardColumn, getBoard, reorderBoardColumns, updateBoardColumn } from "../board";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("board column settings", () => {
  const env = loadEnv();
  const admin = drizzle(postgres(env.DATABASE_ADMIN_URL, { max: 1 }));

  const orgId = "test-boardset-org";
  const userId = "test-boardset-user";
  const teamId = "test-boardset-team";

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  async function resetFixtures() {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Test Board Settings Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "owner", isSuperAdmin: true });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });
  }

  beforeEach(resetFixtures);
  afterAll(cleanup);

  async function seedProject(key: string) {
    return withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key, name: key, actorUserId: userId }),
    );
  }

  it("updateBoardColumn renames/recolors/sets a WIP limit, scoped to the right project", async () => {
    const { boardId } = await seedProject("BSA");
    const [col] = await admin.select().from(schema.boardColumn).where(eq(schema.boardColumn.boardId, boardId)).limit(1);
    const [project] = await admin.select().from(schema.project).where(eq(schema.project.key, "BSA"));

    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      updateBoardColumn(tx, { projectId: project!.id, columnId: col!.id, name: "Renamed", color: "var(--green)", wipLimit: 3 }),
    );

    const [updated] = await admin.select().from(schema.boardColumn).where(eq(schema.boardColumn.id, col!.id));
    expect(updated?.name).toBe("Renamed");
    expect(updated?.color).toBe("var(--green)");
    expect(updated?.wipLimit).toBe(3);
  });

  it("updateBoardColumn rejects a column that belongs to a DIFFERENT project", async () => {
    const { boardId: boardA } = await seedProject("BSB");
    await seedProject("BSC");
    const [projectC] = await admin.select().from(schema.project).where(eq(schema.project.key, "BSC"));
    const [colA] = await admin.select().from(schema.boardColumn).where(eq(schema.boardColumn.boardId, boardA)).limit(1);

    await expect(
      withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
        updateBoardColumn(tx, { projectId: projectC!.id, columnId: colA!.id, name: "Hijacked" }),
      ),
    ).rejects.toThrow();
  });

  it("deleteBoardColumn reassigns tickets to Backlog without touching issue rows, and refuses to delete Backlog itself", async () => {
    const { boardId } = await seedProject("BSD");
    const [project] = await admin.select().from(schema.project).where(eq(schema.project.key, "BSD"));
    const columns = await admin.select().from(schema.boardColumn).where(eq(schema.boardColumn.boardId, boardId)).orderBy(asc(schema.boardColumn.order));
    const backlog = columns.find((c) => c.isBacklog)!;
    const toDoColumn = columns.find((c) => !c.isBacklog)!;

    await expect(
      withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => deleteBoardColumn(tx, { projectId: project!.id, columnId: backlog.id })),
    ).rejects.toThrow("Backlog");

    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => deleteBoardColumn(tx, { projectId: project!.id, columnId: toDoColumn.id }));

    const [deleted] = await admin.select().from(schema.boardColumn).where(eq(schema.boardColumn.id, toDoColumn.id));
    expect(deleted).toBeUndefined();

    // its board_column_status rows now point at Backlog, not orphaned
    const board = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => getBoard(tx, boardId));
    expect(board.columns.find((c) => c.id === toDoColumn.id)).toBeUndefined();
    expect(board.columns.find((c) => c.id === backlog.id)).toBeTruthy();
  });

  it("reorderBoardColumns keeps Backlog first and rejects an incomplete/mismatched set", async () => {
    const { boardId } = await seedProject("BSE");
    const [project] = await admin.select().from(schema.project).where(eq(schema.project.key, "BSE"));
    const columns = await admin.select().from(schema.boardColumn).where(eq(schema.boardColumn.boardId, boardId)).orderBy(asc(schema.boardColumn.order));
    const ids = columns.map((c) => c.id);

    // swap the last two
    const reordered = [...ids];
    const last = reordered.length - 1;
    [reordered[last], reordered[last - 1]] = [reordered[last - 1]!, reordered[last]!];

    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      reorderBoardColumns(tx, { projectId: project!.id, boardId, orderedColumnIds: reordered }),
    );
    const afterReorder = await admin.select().from(schema.boardColumn).where(eq(schema.boardColumn.boardId, boardId)).orderBy(asc(schema.boardColumn.order));
    expect(afterReorder.map((c) => c.id)).toEqual(reordered);

    // Backlog must stay first
    const backlogId = columns.find((c) => c.isBacklog)!.id;
    const movedBacklogToSecond = [ids[1]!, backlogId, ...ids.slice(2)];
    await expect(
      withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
        reorderBoardColumns(tx, { projectId: project!.id, boardId, orderedColumnIds: movedBacklogToSecond }),
      ),
    ).rejects.toThrow("Backlog");

    // missing a column
    await expect(
      withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
        reorderBoardColumns(tx, { projectId: project!.id, boardId, orderedColumnIds: ids.slice(0, -1) }),
      ),
    ).rejects.toThrow();
  });
});
