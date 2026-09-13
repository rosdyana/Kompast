import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, eq, adminDb as admin } from "@kompast/db";
import { createProject } from "../project";
import { createIssue } from "../issue";
import { createSprint } from "../sprint";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";
import { toPlainText } from "../rich-text";
import { listNotifications } from "../notification";
import { listOutgoingLinks } from "../link";
import { executeNode } from "../automation-execution";

describe("automation-execution: executeNode", () => {
  const orgId = "test-exec-org";
  const userId = "test-exec-user";
  const teamId = "test-exec-team";
  const ctx = { userId, organizationId: orgId };

  async function cleanup() {
    await admin.delete(schema.automationWorkflowRunStep).where(eq(schema.automationWorkflowRunStep.runId, "___never_matches___")); // no-op; steps cascade from runs
    await admin.delete(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.organizationId, orgId));
    await admin.delete(schema.automationWorkflow).where(eq(schema.automationWorkflow.organizationId, orgId));
    // action_link_issue's test creates a real link row (createdBy: userId) —
    // must go before the user delete below, or a leftover link row from a
    // previous test's run blocks THIS beforeEach's own user delete with an
    // FK violation.
    await admin.delete(schema.link).where(eq(schema.link.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Exec Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });
  });

  afterAll(cleanup);

  async function seedProjectIssueAndWorkflow(key: string) {
    const { projectId, boardId, issueTypes, statuses } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key, name: key, actorUserId: userId }),
    );
    const { issueId } = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Exec test issue", reporterId: userId }),
    );
    const workflowId = id("wf");
    await admin.insert(schema.automationWorkflow).values({ id: workflowId, organizationId: orgId, projectId, name: "Exec test workflow", createdBy: userId });
    const runId = id("wfrun");
    await admin.insert(schema.automationWorkflowRun).values({ id: runId, organizationId: orgId, workflowId, context: { issueId } });
    return { projectId, boardId, issueId, issueTypes, statuses, workflowId, runId };
  }

  function fakeNode(type: string, config: Record<string, unknown>) {
    return { id: id("anode"), workflowId: "unused", type, config, position: { x: 0, y: 0 } } as never;
  }

  it("condition_property: eq match on a core field routes to the true branch", async () => {
    const { issueId, runId, workflowId } = await seedProjectIssueAndWorkflow("exa");
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("condition_property", { property: "priority", operator: "eq", value: "medium" });
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!, 0));

    expect(result.status).toBe("succeeded");
    expect(result.branchTaken).toBe("true"); // default issue priority is "medium"
    void issueId;
  });

  it("condition_property: no match routes to the false branch", async () => {
    const { runId, workflowId } = await seedProjectIssueAndWorkflow("exb");
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("condition_property", { property: "priority", operator: "eq", value: "highest" });
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!, 0));

    expect(result.branchTaken).toBe("false");
  });

  it("action_set_property on status calls moveIssue (records a transition, not a generic update)", async () => {
    const { issueId, statuses, runId, workflowId } = await seedProjectIssueAndWorkflow("exc");
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("action_set_property", { property: "status", value: statuses[2]!.id });
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!, 0));

    expect(result.status).toBe("succeeded");
    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.statusId).toBe(statuses[2]!.id);
    const history = await admin.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, issueId));
    expect(history.some((h) => h.field === "status")).toBe(true);
  });

  it("action_set_property on assigneeId calls updateIssue", async () => {
    const { issueId, runId, workflowId } = await seedProjectIssueAndWorkflow("exd");
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("action_set_property", { property: "assigneeId", value: userId });
    await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!, 0));

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.assigneeId).toBe(userId);
  });

  it("action_set_property on a custom field key merges into customFields", async () => {
    const { issueId, projectId, runId, workflowId } = await seedProjectIssueAndWorkflow("exe");
    await withAuthorizedTenant(ctx, (tx) =>
      tx.insert(schema.issuePropertyDefinition).values({ id: id("iprop"), projectId, key: "region", name: "Region", type: "text", order: 100 }),
    );
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("action_set_property", { property: "region", value: "APAC" });
    await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!, 0));

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.customFields).toMatchObject({ region: "APAC" });
  });

  it("action_set_property on sprint calls addIssueToSprint, then removeIssueFromSprint when cleared to null", async () => {
    const { issueId, boardId, runId, workflowId } = await seedProjectIssueAndWorkflow("exj");
    const { sprintId } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 1" }));
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const setNode = fakeNode("action_set_property", { property: "sprint", value: sprintId });
    const setResult = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, setNode, run!, workflow!, 0));
    expect(setResult.status).toBe("succeeded");
    const [issueAfterAdd] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issueAfterAdd?.sprintId).toBe(sprintId);
    const sprintIssueRows = await admin.select().from(schema.sprintIssue).where(eq(schema.sprintIssue.issueId, issueId));
    expect(sprintIssueRows.some((r) => r.sprintId === sprintId && r.removedAt === null)).toBe(true);

    const clearNode = fakeNode("action_set_property", { property: "sprint", value: null });
    const clearResult = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, clearNode, run!, workflow!, 0));
    expect(clearResult.status).toBe("succeeded");
    const [issueAfterRemove] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issueAfterRemove?.sprintId).toBeNull();
  });

  it("action_set_property on type or reporterId fails loudly instead of corrupting customFields", async () => {
    const { issueId, issueTypes, runId, workflowId } = await seedProjectIssueAndWorkflow("exk");
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const typeNode = fakeNode("action_set_property", { property: "type", value: issueTypes[1]!.id });
    const typeResult = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, typeNode, run!, workflow!, 0));
    expect(typeResult.status).toBe("failed");
    expect(typeResult.error).toContain("type");

    const reporterNode = fakeNode("action_set_property", { property: "reporterId", value: userId });
    const reporterResult = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, reporterNode, run!, workflow!, 0));
    expect(reporterResult.status).toBe("failed");
    expect(reporterResult.error).toContain("reporterId");

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.customFields).toEqual({});
    expect(issue?.typeId).toBe(issueTypes[0]!.id);
    expect(issue?.reporterId).toBe(userId);
  });

  it("action_add_label appends without duplicating", async () => {
    const { issueId, runId, workflowId } = await seedProjectIssueAndWorkflow("exf");
    await admin.update(schema.issue).set({ labels: ["existing"] }).where(eq(schema.issue.id, issueId));
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("action_add_label", { label: "existing" });
    await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!, 0));

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.labels).toEqual(["existing"]);
  });

  it("action_comment writes a real comment", async () => {
    const { issueId, runId, workflowId } = await seedProjectIssueAndWorkflow("exg");
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("action_comment", { text: "Handled by a workflow" });
    await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!, 0));

    const comments = await admin.select().from(schema.issueComment).where(eq(schema.issueComment.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(toPlainText(comments[0]!.bodyJson)).toBe("Handled by a workflow");
  });

  it("delay sets status to waiting with a future resumeAt and does not mutate the issue", async () => {
    const { issueId, runId, workflowId } = await seedProjectIssueAndWorkflow("exh");
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const before = Date.now();
    const node = fakeNode("delay", { amount: 30, unit: "minutes" });
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!, 0));

    expect(result.status).toBe("waiting");
    expect(result.resumeAt!.getTime()).toBeGreaterThan(before + 29 * 60 * 1000);
    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.updatedAt.getTime()).toBeLessThanOrEqual(before + 1000);
  });

  it("action_notify creates a real in-app notification for the target user (Fix 9)", async () => {
    const { runId, workflowId } = await seedProjectIssueAndWorkflow("exn");
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("action_notify", { userId, title: "Automation notified you", body: "via a workflow" });
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!, 0));

    expect(result.status).toBe("succeeded");
    const notifications = await withAuthorizedTenant(ctx, (tx) => listNotifications(tx, orgId, userId));
    expect(notifications.some((n) => n.title === "Automation notified you" && n.body === "via a workflow")).toBe(true);
  });

  it("action_link_issue creates a real link between the triggering issue and the target issue (Fix 9)", async () => {
    const { issueId, projectId, issueTypes, statuses, runId, workflowId } = await seedProjectIssueAndWorkflow("exo");
    const { issueId: otherIssueId } = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Link target", reporterId: userId }),
    );
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("action_link_issue", { issueId: otherIssueId });
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!, 0));

    expect(result.status).toBe("succeeded");
    const links = await withAuthorizedTenant(ctx, (tx) => listOutgoingLinks(tx, "issue", issueId));
    expect(links.some((l) => l.toId === otherIssueId)).toBe(true);
  });

  it("action_create_subtask creates a real subtask issue with parentId set to the triggering issue (Fix 9)", async () => {
    const { issueId, issueTypes, runId, workflowId } = await seedProjectIssueAndWorkflow("exl");
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("action_create_subtask", { typeId: issueTypes[0]!.id, title: "Auto-created subtask" });
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!, 0));

    expect(result.status).toBe("succeeded");
    const subtasks = await admin.select().from(schema.issue).where(eq(schema.issue.parentId, issueId));
    expect(subtasks).toHaveLength(1);
    expect(subtasks[0]!.title).toBe("Auto-created subtask");
  });

  it("action_create_subtask stamps the SUBTASK's own emitted issue.created event with the acting step's depth, not 0 (Fix 7 regression case)", async () => {
    // Before Fix 7, executeNode always hardcoded automationContext to
    // { depth: 0, workflowId }, relying on a compensating UPDATE in
    // automation-engine.ts to fix depth up afterward — an UPDATE keyed on
    // the RUN's own triggering issueId, which never matched an event for a
    // DIFFERENT entity (the newly created subtask). That let a
    // subtask-creation loop bypass MAX_AUTOMATION_DEPTH entirely. Fix 7
    // threads the acting step's depth straight into executeNode instead,
    // so this can no longer happen — verified here directly (no need to
    // drive a real advanceWorkflowStep chain since executeNode alone now
    // fully determines the emitted event's depth).
    const { issueId, issueTypes, runId, workflowId } = await seedProjectIssueAndWorkflow("exm");
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("action_create_subtask", { typeId: issueTypes[0]!.id, title: "Depth-stamped subtask" });
    const actingStepDepth = 3;
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!, actingStepDepth));
    expect(result.status).toBe("succeeded");

    const [subtask] = await admin.select().from(schema.issue).where(eq(schema.issue.parentId, issueId));
    const [subtaskEvent] = await admin.select().from(schema.automationWorkflowEvent).where(eq(schema.automationWorkflowEvent.entityId, subtask!.id));
    expect(subtaskEvent!.depth).toBe(actingStepDepth);
    expect(subtaskEvent!.causedByWorkflowId).toBe(workflowId);
  });

  it("dry-run workflow computes the action but never applies it", async () => {
    const { issueId, runId, workflowId } = await seedProjectIssueAndWorkflow("exi");
    await admin.update(schema.automationWorkflow).set({ dryRun: true }).where(eq(schema.automationWorkflow.id, workflowId));
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));

    const node = fakeNode("action_add_label", { label: "would-be-added" });
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run!, workflow!, 0));

    expect(result.status).toBe("succeeded");
    expect(result.output).toMatchObject({ dryRun: true });
    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.labels).toEqual([]);
  });
});

describe("automation-execution: action_webhook", () => {
  const orgId = "test-exec-webhook-org";
  const userId = "test-exec-webhook-user";
  const teamId = "test-exec-webhook-team";
  const ctx = { userId, organizationId: orgId };

  async function cleanup() {
    await admin.delete(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.organizationId, orgId));
    await admin.delete(schema.automationWorkflow).where(eq(schema.automationWorkflow.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Webhook Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });
  });

  afterAll(cleanup);

  async function seed(key: string) {
    const { projectId, issueTypes, statuses } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key, name: key, actorUserId: userId }),
    );
    const { issueId } = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Webhook test issue", reporterId: userId }),
    );
    const workflowId = id("wf");
    await admin.insert(schema.automationWorkflow).values({ id: workflowId, organizationId: orgId, projectId, name: "Webhook workflow", createdBy: userId });
    const runId = id("wfrun");
    await admin.insert(schema.automationWorkflowRun).values({ id: runId, organizationId: orgId, workflowId, context: { issueId } });
    const [run] = await admin.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
    const [workflow] = await admin.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));
    return { run: run!, workflow: workflow! };
  }

  it("sends the configured method/url/headers/body and succeeds on a 2xx response", async () => {
    const { run, workflow } = await seed("hka");
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const node = { id: id("anode"), workflowId: "unused", type: "action_webhook", config: { url: "https://example.com/hook", method: "POST", headers: { "X-Test": "1" }, bodyTemplate: { issue: "{{issueId}}" } }, position: { x: 0, y: 0 } } as never;
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run, workflow, 0));

    expect(result.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.com/hook");
    expect(options.method).toBe("POST");
    expect(options.headers["X-Test"]).toBe("1");
    vi.unstubAllGlobals();
  });

  it("a non-2xx response marks the step failed with the status captured, never throws unhandled", async () => {
    const { run, workflow } = await seed("hkb");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));

    const node = { id: id("anode"), workflowId: "unused", type: "action_webhook", config: { url: "https://example.com/hook", method: "POST", headers: {}, bodyTemplate: {} }, position: { x: 0, y: 0 } } as never;
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run, workflow, 0));

    expect(result.status).toBe("failed");
    expect(result.error).toContain("500");
    vi.unstubAllGlobals();
  });

  it("a network error (fetch rejects) marks the step failed, never throws unhandled", async () => {
    const { run, workflow } = await seed("hkc");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const node = { id: id("anode"), workflowId: "unused", type: "action_webhook", config: { url: "https://example.com/hook", method: "POST", headers: {}, bodyTemplate: {} }, position: { x: 0, y: 0 } } as never;
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run, workflow, 0));

    expect(result.status).toBe("failed");
    expect(result.error).toContain("ECONNREFUSED");
    vi.unstubAllGlobals();
  });

  it("a hung target (fetch never resolves) is aborted via the bounded timeout signal and marks the step failed (Fix 3)", async () => {
    const { run, workflow } = await seed("hkd");
    // Simulates the real AbortSignal.timeout(10_000) eventually firing on a
    // hung target, WITHOUT this test actually waiting out the real 10
    // seconds: our mock fetch never resolves on its own (like a genuinely
    // hung target) but immediately dispatches its own "abort" event on the
    // signal it was handed, exercising exactly the codepath a real timeout
    // firing after 10s would — including proving executeNode really does
    // pass an AbortSignal into fetch at all.
    //
    // The signal is captured here and asserted on BELOW, outside this
    // callback: an assertion thrown from inside a vi.fn() mock callback is
    // silently swallowed under the Vitest version installed in this repo
    // (3.2.7) — it does not propagate up to fail the test — so asserting
    // in here would pass unconditionally regardless of whether executeNode
    // actually wires up the timeout signal at all.
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, options: RequestInit) => {
      capturedSignal = options.signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        if (!capturedSignal) {
          // Nothing to hang on and nothing to abort — reject immediately so
          // a missing signal fails fast below instead of timing out the test.
          reject(new Error("test bug: no AbortSignal was passed to fetch"));
          return;
        }
        capturedSignal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
        capturedSignal.dispatchEvent(new Event("abort"));
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const node = { id: id("anode"), workflowId: "unused", type: "action_webhook", config: { url: "https://example.com/hook", method: "POST", headers: {}, bodyTemplate: {} }, position: { x: 0, y: 0 } } as never;
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run, workflow, 0));

    expect(result.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    vi.unstubAllGlobals();
  });

  it("rejects a webhook target that resolves to a loopback address, before ever calling fetch (Fix 4, SSRF guard)", async () => {
    const { run, workflow } = await seed("hke");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // A literal IP's DNS lookup is instant (no real network call) — no need
    // to mock dns.lookup itself.
    const node = { id: id("anode"), workflowId: "unused", type: "action_webhook", config: { url: "http://127.0.0.1:1/webhook", method: "POST", headers: {}, bodyTemplate: {} }, position: { x: 0, y: 0 } } as never;
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run, workflow, 0));

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/disallowed address/);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("blocks a redirect response instead of following it, even though the initial URL passed the SSRF guard (Fix 5, redirect bypass)", async () => {
    const { run, workflow } = await seed("hkf");
    const redirectTarget = "http://169.254.169.254/latest/meta-data/";
    // This mock deliberately simulates REAL fetch redirect semantics (not
    // just a dumb canned response) so the test genuinely discriminates
    // between "redirect followed" and "redirect blocked":
    //  - if executeNode passes redirect: "manual" (the fix), we return the
    //    3xx response as Node's native fetch actually does under manual
    //    redirect mode in this repo's runtime (status/headers intact,
    //    confirmed empirically — see scratch script used while diagnosing
    //    this fix), and fetch is called exactly once.
    //  - if executeNode omits the redirect option (pre-fix), this mock
    //    stands in for fetch's real default "follow" behavior and resolves
    //    the redirect itself, returning a 200 as if the metadata endpoint
    //    had actually been reached. It also hard-fails if ever called with
    //    the redirect target directly, which would mean OUR code (not this
    //    mock) tried to follow the redirect itself.
    const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
      if (url === redirectTarget) {
        throw new Error("test bug: fetch was called with the redirect target — the redirect was followed");
      }
      if (options.redirect === "manual") {
        return new Response(null, { status: 302, headers: { Location: redirectTarget } });
      }
      return new Response("metadata leaked", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const node = { id: id("anode"), workflowId: "unused", type: "action_webhook", config: { url: "https://example.com/hook", method: "POST", headers: {}, bodyTemplate: {} }, position: { x: 0, y: 0 } } as never;
    const result = await withAuthorizedTenant(ctx, (tx) => executeNode(tx, node, run, workflow, 0));

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/redirect/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
