import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { adminDb, eq, schema } from "@kompast/db";
import { signCollabToken, FIRST_RANK } from "@kompast/core";
import { createCollabServer } from "../server";

const PORT = 14173;

function connect(pageId: string, doc: Y.Doc, token: string) {
  return new HocuspocusProvider({ url: `ws://127.0.0.1:${PORT}`, name: pageId, document: doc, token });
}

async function waitForRow(pageId: string, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await adminDb.select().from(schema.ydocState).where(eq(schema.ydocState.pageId, pageId));
    if (row) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

async function waitForOutcome(provider: HocuspocusProvider, timeoutMs = 5000): Promise<"synced" | "authenticationFailed" | "timeout"> {
  return new Promise((resolve) => {
    provider.on("synced", () => resolve("synced"));
    provider.on("authenticationFailed", () => resolve("authenticationFailed"));
    setTimeout(() => resolve("timeout"), timeoutMs);
  });
}

describe("collab server", () => {
  const server = createCollabServer(PORT);
  const orgId = "test-collab-org";
  const userId = "test-collab-user";
  const pageIds = ["test-collab-page-persist", "test-collab-page-load", "test-collab-page-reject", "test-collab-page-mismatch"];

  beforeAll(async () => {
    await server.listen();

    await adminDb.delete(schema.ydocState).where(eq(schema.ydocState.pageId, pageIds[0]!));
    await adminDb.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await adminDb.delete(schema.user).where(eq(schema.user.id, userId));
    await adminDb.delete(schema.organization).where(eq(schema.organization.id, orgId));

    await adminDb.insert(schema.organization).values({ id: orgId, name: "Collab Org", slug: orgId });
    await adminDb.insert(schema.user).values({ id: userId, name: "Collab User", email: `${userId}@example.com` });
    await adminDb.insert(schema.page).values(
      pageIds.map((id) => ({ id, organizationId: orgId, title: id, rank: FIRST_RANK, createdBy: userId })),
    );
  });

  afterAll(async () => {
    await adminDb.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await adminDb.delete(schema.user).where(eq(schema.user.id, userId));
    await adminDb.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await server.destroy();
  });

  it("persists a real client's Yjs update to ydoc_state, round-trippable", async () => {
    const pageId = "test-collab-page-persist";
    const token = signCollabToken({ userId, organizationId: orgId, pageId, role: "edit" });
    const doc = new Y.Doc();
    const provider = connect(pageId, doc, token);

    try {
      expect(await waitForOutcome(provider)).toBe("synced");

      doc.getText("content").insert(0, "hello from a real client");
      server.hocuspocus.flushPendingStores();

      const row = await waitForRow(pageId);
      expect(row).toBeDefined();

      const restored = new Y.Doc();
      Y.applyUpdate(restored, row!.state);
      expect(restored.getText("content").toString()).toBe("hello from a real client");
    } finally {
      provider.destroy();
    }
  });

  it("loads previously-stored state back into a fresh connection", async () => {
    const pageId = "test-collab-page-load";
    const seed = new Y.Doc();
    seed.getText("content").insert(0, "seeded content");
    await adminDb.insert(schema.ydocState).values({ pageId, state: Buffer.from(Y.encodeStateAsUpdate(seed)) });

    const token = signCollabToken({ userId, organizationId: orgId, pageId, role: "view" });
    const doc = new Y.Doc();
    const provider = connect(pageId, doc, token);

    try {
      expect(await waitForOutcome(provider)).toBe("synced");
      expect(doc.getText("content").toString()).toBe("seeded content");
    } finally {
      provider.destroy();
    }
  });

  it("rejects a connection with an invalid token", async () => {
    const doc = new Y.Doc();
    const provider = connect("test-collab-page-reject", doc, "not-a-real-token");

    try {
      expect(await waitForOutcome(provider)).toBe("authenticationFailed");
    } finally {
      provider.destroy();
    }
  });

  it("rejects a token whose pageId does not match the requested document", async () => {
    const token = signCollabToken({ userId, organizationId: orgId, pageId: "wrong-page", role: "edit" });
    const doc = new Y.Doc();
    const provider = connect("test-collab-page-mismatch", doc, token);

    try {
      expect(await waitForOutcome(provider)).toBe("authenticationFailed");
    } finally {
      provider.destroy();
    }
  });
});
