import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, adminDb as admin } from "@kompast/db";
import { createProject, withAuthorizedTenant } from "@kompast/core";
import { id } from "@kompast/core/ids";
import { getAuth } from "../../../../lib/auth";
import { Route as WorkflowsRoute } from "../automation.workflows";
import { Route as WorkflowItemRoute } from "../automation.workflows.$workflowId";
import { Route as WorkflowRunsRoute } from "../automation.workflows.$workflowId.runs";

type Handler = (opts: { request: Request; params: Record<string, string> }) => Promise<Response>;
const workflowsHandlers = WorkflowsRoute.options.server!.handlers as { GET: Handler; POST: Handler };
const workflowItemHandlers = WorkflowItemRoute.options.server!.handlers as { GET: Handler; PATCH: Handler; DELETE: Handler };
const workflowRunsHandlers = WorkflowRunsRoute.options.server!.handlers as { GET: Handler };

function req(url: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method: options.method ?? "GET", headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
}

describe("/api/v1/automation/workflows", () => {
  const orgId = "test-rest-workflows-org";
  const userId = "test-rest-workflows-user";
  const teamId = "test-rest-workflows-team";
  let token: string;
  let projectKey: string;

  async function cleanup() {
    await admin.delete(schema.automationWorkflow).where(eq(schema.automationWorkflow.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.apikey).where(eq(schema.apikey.referenceId, userId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "REST Workflows Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });

    projectKey = Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: projectKey, name: "REST Workflows Test", actorUserId: userId }),
    );

    const auth = await getAuth();
    const created = await auth.api.createApiKey({ body: { userId, permissions: { issues: ["read", "write"] }, metadata: { organizationId: orgId } } });
    token = created.key;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("creates a workflow, lists it, gets it, patches (full graph replace) it, lists its runs, and deletes it", async () => {
    const createRes = await workflowsHandlers.POST({
      request: req("http://x/api/v1/automation/workflows", {
        method: "POST",
        token,
        body: {
          projectKey,
          name: "Label on transition",
          nodes: [{ id: "n1", type: "trigger_event", config: {}, position: { x: 0, y: 0 } }],
          edges: [],
        },
      }),
      params: {},
    });
    expect(createRes.status).toBe(201);
    const { id: workflowId } = await createRes.json();

    const listRes = await workflowsHandlers.GET({ request: req(`http://x/api/v1/automation/workflows?projectKey=${projectKey}`, { token }), params: {} });
    const list = await listRes.json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0].id).toBe(workflowId);

    const getRes = await workflowItemHandlers.GET({ request: req(`http://x/api/v1/automation/workflows/${workflowId}`, { token }), params: { workflowId } });
    expect(getRes.status).toBe(200);
    const got = await getRes.json();
    expect(got.data.nodes).toHaveLength(1);
    expect(got.data.edges).toHaveLength(0);

    const patchRes = await workflowItemHandlers.PATCH({
      request: req(`http://x/api/v1/automation/workflows/${workflowId}`, {
        method: "PATCH",
        token,
        body: {
          projectKey,
          name: "Patched name",
          enabled: false,
          dryRun: true,
          nodes: [
            { id: "n1", type: "trigger_event", config: {}, position: { x: 0, y: 0 } },
            { id: "n2", type: "action_add_label", config: { label: "patched" }, position: { x: 100, y: 0 } },
          ],
          edges: [{ fromNodeId: "n1", toNodeId: "n2" }],
        },
      }),
      params: { workflowId },
    });
    expect(patchRes.status).toBe(200);

    const afterPatchRes = await workflowItemHandlers.GET({ request: req(`http://x/api/v1/automation/workflows/${workflowId}`, { token }), params: { workflowId } });
    const afterPatch = await afterPatchRes.json();
    expect(afterPatch.data.name).toBe("Patched name");
    expect(afterPatch.data.enabled).toBe(false);
    expect(afterPatch.data.dryRun).toBe(true);
    expect(afterPatch.data.nodes).toHaveLength(2);
    expect(afterPatch.data.edges).toHaveLength(1);

    const runsRes = await workflowRunsHandlers.GET({ request: req(`http://x/api/v1/automation/workflows/${workflowId}/runs`, { token }), params: { workflowId } });
    expect(runsRes.status).toBe(200);
    const runs = await runsRes.json();
    expect(runs.data).toEqual([]);

    const deleteRes = await workflowItemHandlers.DELETE({ request: req(`http://x/api/v1/automation/workflows/${workflowId}`, { method: "DELETE", token }), params: { workflowId } });
    expect(deleteRes.status).toBe(200);
    const afterDelete = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));
    expect(afterDelete).toHaveLength(0);

    const getAfterDeleteRes = await workflowItemHandlers.GET({ request: req(`http://x/api/v1/automation/workflows/${workflowId}`, { token }), params: { workflowId } });
    expect(getAfterDeleteRes.status).toBe(404);
  });

  it("rejects a PATCH that sends only one of nodes/edges", async () => {
    const createRes = await workflowsHandlers.POST({
      request: req("http://x/api/v1/automation/workflows", {
        method: "POST",
        token,
        body: { projectKey, name: "Partial patch guard", nodes: [{ id: "n1", type: "trigger_event", config: {}, position: { x: 0, y: 0 } }], edges: [] },
      }),
      params: {},
    });
    const { id: workflowId } = await createRes.json();

    const nodesOnlyRes = await workflowItemHandlers.PATCH({
      request: req(`http://x/api/v1/automation/workflows/${workflowId}`, {
        method: "PATCH",
        token,
        body: { projectKey, nodes: [{ id: "n1", type: "trigger_event", config: {}, position: { x: 0, y: 0 } }] },
      }),
      params: { workflowId },
    });
    expect(nodesOnlyRes.status).toBe(400);

    const edgesOnlyRes = await workflowItemHandlers.PATCH({
      request: req(`http://x/api/v1/automation/workflows/${workflowId}`, { method: "PATCH", token, body: { projectKey, edges: [] } }),
      params: { workflowId },
    });
    expect(edgesOnlyRes.status).toBe(400);
  });

  it("returns 404 (not 500/200) for PATCH/DELETE/runs against a nonexistent workflowId", async () => {
    const bogusId = "wf_does_not_exist";

    const patchRes = await workflowItemHandlers.PATCH({
      request: req(`http://x/api/v1/automation/workflows/${bogusId}`, { method: "PATCH", token, body: { projectKey, name: "Nope" } }),
      params: { workflowId: bogusId },
    });
    expect(patchRes.status).toBe(404);

    const deleteRes = await workflowItemHandlers.DELETE({
      request: req(`http://x/api/v1/automation/workflows/${bogusId}`, { method: "DELETE", token }),
      params: { workflowId: bogusId },
    });
    expect(deleteRes.status).toBe(404);

    const runsRes = await workflowRunsHandlers.GET({
      request: req(`http://x/api/v1/automation/workflows/${bogusId}/runs`, { token }),
      params: { workflowId: bogusId },
    });
    expect(runsRes.status).toBe(404);
  });

  it("returns 404 for a PATCH whose workflowId exists but belongs to a different project", async () => {
    const createRes = await workflowsHandlers.POST({
      request: req("http://x/api/v1/automation/workflows", {
        method: "POST",
        token,
        body: { projectKey, name: "Cross-project guard", nodes: [{ id: "n1", type: "trigger_event", config: {}, position: { x: 0, y: 0 } }], edges: [] },
      }),
      params: {},
    });
    const { id: workflowId } = await createRes.json();

    const otherProjectKey = Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: otherProjectKey, name: "REST Workflows Other Project", actorUserId: userId }),
    );

    const patchRes = await workflowItemHandlers.PATCH({
      request: req(`http://x/api/v1/automation/workflows/${workflowId}`, { method: "PATCH", token, body: { projectKey: otherProjectKey, name: "Nope" } }),
      params: { workflowId },
    });
    expect(patchRes.status).toBe(404);
  });

  it("rejects workflow creation from a token without issues:write", async () => {
    const auth = await getAuth();
    const readOnly = await auth.api.createApiKey({ body: { userId, permissions: { issues: ["read"] }, metadata: { organizationId: orgId } } });
    const res = await workflowsHandlers.POST({
      request: req("http://x/api/v1/automation/workflows", {
        method: "POST",
        token: readOnly.key,
        body: { projectKey, name: "Nope", nodes: [{ id: "n1", type: "trigger_event", config: {}, position: { x: 0, y: 0 } }], edges: [] },
      }),
      params: {},
    });
    expect(res.status).toBe(401);
  });
});
