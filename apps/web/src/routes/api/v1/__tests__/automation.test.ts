import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, and, adminDb as admin } from "@kompast/db";
import { createProject, evaluateAutomationEvent, withAuthorizedTenant } from "@kompast/core";
import { id } from "@kompast/core/ids";
import { getAuth } from "../../../../lib/auth";
import { Route as RulesRoute } from "../automation.rules";
import { Route as RuleItemRoute } from "../automation.rules.$ruleId";
import { Route as RuleRunsRoute } from "../automation.rules.$ruleId.runs";
import { Route as IssuesRoute } from "../issues";
import { Route as TransitionRoute } from "../issues.$issueKey.transition";

type Handler = (opts: { request: Request; params: Record<string, string> }) => Promise<Response>;
const rulesHandlers = RulesRoute.options.server!.handlers as { GET: Handler; POST: Handler };
const ruleItemHandlers = RuleItemRoute.options.server!.handlers as { GET: Handler; PATCH: Handler; DELETE: Handler };
const ruleRunsHandlers = RuleRunsRoute.options.server!.handlers as { GET: Handler };
const issuesHandlers = IssuesRoute.options.server!.handlers as { GET: Handler; POST: Handler };
const transitionHandlers = TransitionRoute.options.server!.handlers as { POST: Handler };

function req(url: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method: options.method ?? "GET", headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
}

describe("/api/v1/automation/rules", () => {
  const orgId = "test-rest-automation-org";
  const userId = "test-rest-automation-user";
  const teamId = "test-rest-automation-team";
  let token: string;
  let projectKey: string;

  async function cleanup() {
    await admin.delete(schema.automationRun).where(eq(schema.automationRun.organizationId, orgId));
    await admin.delete(schema.automationEvent).where(eq(schema.automationEvent.organizationId, orgId));
    await admin.delete(schema.automationRule).where(eq(schema.automationRule.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.apikey).where(eq(schema.apikey.referenceId, userId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "REST Automation Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });

    projectKey = Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: projectKey, name: "REST Automation Test", actorUserId: userId }),
    );

    const auth = await getAuth();
    const created = await auth.api.createApiKey({ body: { userId, permissions: { issues: ["read", "write"] }, metadata: { organizationId: orgId } } });
    token = created.key;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("creates a rule, lists it, and updates+deletes it", async () => {
    const createRes = await rulesHandlers.POST({
      request: req("http://x/api/v1/automation/rules", {
        method: "POST",
        token,
        body: { projectKey, name: "Label on transition", trigger: { type: "issue.transitioned" }, actions: [{ type: "add_label", label: "auto" }] },
      }),
      params: {},
    });
    expect(createRes.status).toBe(201);
    const { id: ruleId } = await createRes.json();

    const listRes = await rulesHandlers.GET({ request: req(`http://x/api/v1/automation/rules?projectKey=${projectKey}`, { token }), params: {} });
    const list = await listRes.json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0].id).toBe(ruleId);

    const patchRes = await ruleItemHandlers.PATCH({ request: req(`http://x/api/v1/automation/rules/${ruleId}`, { method: "PATCH", token, body: { enabled: false } }), params: { ruleId } });
    expect(patchRes.status).toBe(200);
    const [row] = await admin.select().from(schema.automationRule).where(eq(schema.automationRule.id, ruleId));
    expect(row?.enabled).toBe(false);

    const deleteRes = await ruleItemHandlers.DELETE({ request: req(`http://x/api/v1/automation/rules/${ruleId}`, { method: "DELETE", token }), params: { ruleId } });
    expect(deleteRes.status).toBe(200);
    const afterDelete = await admin.select().from(schema.automationRule).where(eq(schema.automationRule.id, ruleId));
    expect(afterDelete).toHaveLength(0);
  });

  it("a rule created via REST actually fires end-to-end (create issue -> transition -> engine evaluates -> label applied -> run logged and readable via REST)", async () => {
    const createRuleRes = await rulesHandlers.POST({
      request: req("http://x/api/v1/automation/rules", {
        method: "POST",
        token,
        body: { projectKey, name: "E2E label rule", trigger: { type: "issue.transitioned" }, actions: [{ type: "add_label", label: "e2e-tested" }] },
      }),
      params: {},
    });
    const { id: ruleId } = await createRuleRes.json();

    const issue = await (await issuesHandlers.POST({ request: req("http://x/api/v1/issues", { method: "POST", token, body: { projectKey, title: "E2E issue" } }), params: {} })).json();
    await transitionHandlers.POST({ request: req(`http://x/api/v1/issues/${issue.key}/transition`, { method: "POST", token, body: { status: "In Progress" } }), params: { issueKey: issue.key } });

    const [event] = await admin
      .select()
      .from(schema.automationEvent)
      .where(and(eq(schema.automationEvent.entityId, issue.id), eq(schema.automationEvent.eventType, "issue.transitioned")));
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => evaluateAutomationEvent(tx, event!));

    const [updatedIssue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issue.id));
    expect(updatedIssue?.labels).toEqual(["e2e-tested"]);

    const runsRes = await ruleRunsHandlers.GET({ request: req(`http://x/api/v1/automation/rules/${ruleId}/runs`, { token }), params: { ruleId } });
    const runs = await runsRes.json();
    expect(runs.data).toHaveLength(1);
    expect(runs.data[0].status).toBe("matched");
  });

  it("rejects rule creation from a token without issues:write", async () => {
    const auth = await getAuth();
    const readOnly = await auth.api.createApiKey({ body: { userId, permissions: { issues: ["read"] }, metadata: { organizationId: orgId } } });
    const res = await rulesHandlers.POST({
      request: req("http://x/api/v1/automation/rules", { method: "POST", token: readOnly.key, body: { projectKey, name: "Nope", trigger: { type: "issue.created" }, actions: [] } }),
      params: {},
    });
    expect(res.status).toBe(401);
  });
});
