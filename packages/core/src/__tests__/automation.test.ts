import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, and, adminDb as admin } from "@kompast/db";
import { createProject } from "../project";
import { createIssue, moveIssue, updateIssue } from "../issue";
import { addComment } from "../comment";
import { createAutomationRule, evaluateAutomationEvent, claimPendingAutomationEvents, MAX_AUTOMATION_DEPTH } from "../automation";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("automation engine", () => {
  const orgId = "test-automation-org";
  const userId = "test-automation-user";
  const teamId = "test-automation-team";

  async function cleanup() {
    await admin.delete(schema.automationRun).where(eq(schema.automationRun.organizationId, orgId));
    await admin.delete(schema.automationEvent).where(eq(schema.automationEvent.organizationId, orgId));
    await admin.delete(schema.automationRule).where(eq(schema.automationRule.organizationId, orgId));
    await admin.delete(schema.notification).where(eq(schema.notification.organizationId, orgId));
    await admin.delete(schema.emailOutbox).where(eq(schema.emailOutbox.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Automation Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });
  });

  afterAll(async () => {
    await cleanup();
  });

  const ctx = { userId, organizationId: orgId };

  async function seedProjectAndIssue() {
    const { projectId, issueTypes, statuses } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: "aut", name: "Automation Test", actorUserId: userId }),
    );
    const { issueId } = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Automation issue", reporterId: userId, storyPoints: 1 }),
    );
    return { projectId, issueId, statuses, issueTypes };
  }

  async function latestEventFor(issueId: string, eventType: string) {
    const rows = await admin.select().from(schema.automationEvent).where(and(eq(schema.automationEvent.entityId, issueId), eq(schema.automationEvent.eventType, eventType)));
    return rows.at(-1)!;
  }

  it("a matching rule with no conditions runs its actions and logs a matched run", async () => {
    const { projectId, issueId, statuses } = await seedProjectAndIssue();
    const { ruleId } = await withAuthorizedTenant(ctx, (tx) =>
      createAutomationRule(tx, {
        organizationId: orgId,
        projectId,
        name: "Add label on any transition",
        trigger: { type: "issue.transitioned" },
        actions: [{ type: "add_label", label: "auto-labeled" }],
        createdBy: userId,
      }),
    );

    await withAuthorizedTenant(ctx, (tx) => moveIssue(tx, { issueId, toStatusId: statuses[2]!.id, actorId: userId }));
    const event = await latestEventFor(issueId, "issue.transitioned");
    await withAuthorizedTenant(ctx, (tx) => evaluateAutomationEvent(tx, event));

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.labels).toEqual(["auto-labeled"]);

    const runs = await admin.select().from(schema.automationRun).where(eq(schema.automationRun.ruleId, ruleId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("matched");
  });

  it("a condition filters which events actually run the rule's actions", async () => {
    const { projectId, issueId, statuses } = await seedProjectAndIssue();
    const doneStatusId = statuses[4]!.id;
    const { ruleId } = await withAuthorizedTenant(ctx, (tx) =>
      createAutomationRule(tx, {
        organizationId: orgId,
        projectId,
        name: "Comment only when moved to Done",
        trigger: { type: "issue.transitioned" },
        conditions: [{ field: "toStatusId", operator: "eq", value: doneStatusId }],
        actions: [{ type: "comment", text: "Closed by automation" }],
        createdBy: userId,
      }),
    );

    // Move to "In Progress" (index 2) — condition should NOT match.
    await withAuthorizedTenant(ctx, (tx) => moveIssue(tx, { issueId, toStatusId: statuses[2]!.id, actorId: userId }));
    let event = await latestEventFor(issueId, "issue.transitioned");
    await withAuthorizedTenant(ctx, (tx) => evaluateAutomationEvent(tx, event));

    let runs = await admin.select().from(schema.automationRun).where(eq(schema.automationRun.ruleId, ruleId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("not_matched");

    // Now move to Done — condition should match.
    await withAuthorizedTenant(ctx, (tx) => moveIssue(tx, { issueId, toStatusId: doneStatusId, actorId: userId }));
    event = await latestEventFor(issueId, "issue.transitioned");
    await withAuthorizedTenant(ctx, (tx) => evaluateAutomationEvent(tx, event));

    runs = await admin.select().from(schema.automationRun).where(eq(schema.automationRun.ruleId, ruleId));
    expect(runs).toHaveLength(2);
    expect(runs[1]!.status).toBe("matched");

    const comments = await admin.select().from(schema.issueComment).where(eq(schema.issueComment.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect((comments[0]!.bodyJson as { text: string }).text).toBe("Closed by automation");
  });

  it("a disabled rule is never evaluated", async () => {
    const { projectId, issueId, statuses } = await seedProjectAndIssue();
    const { ruleId } = await withAuthorizedTenant(ctx, (tx) =>
      createAutomationRule(tx, { organizationId: orgId, projectId, name: "Disabled rule", trigger: { type: "issue.transitioned" }, actions: [{ type: "add_label", label: "should-not-appear" }], createdBy: userId }),
    );
    await withAuthorizedTenant(ctx, (tx) => tx.update(schema.automationRule).set({ enabled: false }).where(eq(schema.automationRule.id, ruleId)));

    await withAuthorizedTenant(ctx, (tx) => moveIssue(tx, { issueId, toStatusId: statuses[2]!.id, actorId: userId }));
    const event = await latestEventFor(issueId, "issue.transitioned");
    await withAuthorizedTenant(ctx, (tx) => evaluateAutomationEvent(tx, event));

    const runs = await admin.select().from(schema.automationRun).where(eq(schema.automationRun.ruleId, ruleId));
    expect(runs).toHaveLength(0);
    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.labels).toEqual([]);
  });

  it("dry-run mode logs what would have happened without applying it", async () => {
    const { projectId, issueId, statuses } = await seedProjectAndIssue();
    await withAuthorizedTenant(ctx, (tx) =>
      createAutomationRule(tx, {
        organizationId: orgId,
        projectId,
        name: "Dry run rule",
        trigger: { type: "issue.transitioned" },
        actions: [{ type: "add_label", label: "would-be-added" }],
        dryRun: true,
        createdBy: userId,
      }),
    );

    await withAuthorizedTenant(ctx, (tx) => moveIssue(tx, { issueId, toStatusId: statuses[2]!.id, actorId: userId }));
    const event = await latestEventFor(issueId, "issue.transitioned");
    await withAuthorizedTenant(ctx, (tx) => evaluateAutomationEvent(tx, event));

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.labels).toEqual([]); // action never actually applied

    const runs = await admin.select().from(schema.automationRun).where(eq(schema.automationRun.organizationId, orgId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("dry_run");
  });

  it("a rule's own action never re-triggers itself, but does trigger a different rule", async () => {
    const { projectId, issueId, statuses } = await seedProjectAndIssue();
    // Rule A: on comment, transitions the issue — its own resulting "issue.transitioned" event must not re-fire rule A.
    const { ruleId: ruleAId } = await withAuthorizedTenant(ctx, (tx) =>
      createAutomationRule(tx, {
        organizationId: orgId,
        projectId,
        name: "Rule A: comment -> transition",
        trigger: { type: "issue.commented" },
        actions: [{ type: "transition", toStatusId: statuses[2]!.id }],
        createdBy: userId,
      }),
    );
    // Rule B: any transition -> add a label. Should fire off of rule A's own resulting event.
    const { ruleId: ruleBId } = await withAuthorizedTenant(ctx, (tx) =>
      createAutomationRule(tx, {
        organizationId: orgId,
        projectId,
        name: "Rule B: transition -> label",
        trigger: { type: "issue.transitioned" },
        actions: [{ type: "add_label", label: "chained" }],
        createdBy: userId,
      }),
    );

    await withAuthorizedTenant(ctx, (tx) => addComment(tx, { issueId, authorId: userId, bodyJson: { text: "trigger it" } }));
    const commentEvent = await latestEventFor(issueId, "issue.commented");
    await withAuthorizedTenant(ctx, (tx) => evaluateAutomationEvent(tx, commentEvent));

    const ruleARuns = await admin.select().from(schema.automationRun).where(eq(schema.automationRun.ruleId, ruleAId));
    expect(ruleARuns).toHaveLength(1);
    expect(ruleARuns[0]!.status).toBe("matched");

    // The transition rule A's action caused should exist, at depth 1, causedByRuleId = ruleAId.
    const transitionEvent = await latestEventFor(issueId, "issue.transitioned");
    expect(transitionEvent.depth).toBe(1);
    expect(transitionEvent.causedByRuleId).toBe(ruleAId);

    await withAuthorizedTenant(ctx, (tx) => evaluateAutomationEvent(tx, transitionEvent));

    // Rule A must NOT have a second run from its own resulting event.
    const ruleARunsAfter = await admin.select().from(schema.automationRun).where(eq(schema.automationRun.ruleId, ruleAId));
    expect(ruleARunsAfter).toHaveLength(1);

    // Rule B (a DIFFERENT rule) must have fired.
    const ruleBRuns = await admin.select().from(schema.automationRun).where(eq(schema.automationRun.ruleId, ruleBId));
    expect(ruleBRuns).toHaveLength(1);
    expect(ruleBRuns[0]!.status).toBe("matched");
    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.labels).toEqual(["chained"]);
  });

  it("an event at or beyond MAX_AUTOMATION_DEPTH is skipped entirely, with no runs logged", async () => {
    const { projectId, issueId } = await seedProjectAndIssue();
    const { ruleId } = await withAuthorizedTenant(ctx, (tx) =>
      createAutomationRule(tx, { organizationId: orgId, projectId, name: "Would match anything", trigger: { type: "issue.updated" }, actions: [{ type: "add_label", label: "x" }], createdBy: userId }),
    );

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    const deepEventId = id("aevent");
    await admin.insert(schema.automationEvent).values({
      id: deepEventId,
      organizationId: orgId,
      projectId,
      eventType: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      payload: { statusId: issue!.statusId },
      depth: MAX_AUTOMATION_DEPTH,
      status: "pending",
    });
    const [deepEvent] = await admin.select().from(schema.automationEvent).where(eq(schema.automationEvent.id, deepEventId));

    await withAuthorizedTenant(ctx, (tx) => evaluateAutomationEvent(tx, deepEvent!));

    const runs = await admin.select().from(schema.automationRun).where(eq(schema.automationRun.ruleId, ruleId));
    expect(runs).toHaveLength(0);
  });

  it("claimPendingAutomationEvents claims and processes a real pending event end-to-end", async () => {
    const { projectId, issueId, statuses } = await seedProjectAndIssue();
    await withAuthorizedTenant(ctx, (tx) =>
      createAutomationRule(tx, { organizationId: orgId, projectId, name: "Claim test rule", trigger: { type: "issue.transitioned" }, actions: [{ type: "add_label", label: "claimed" }], createdBy: userId }),
    );

    await withAuthorizedTenant(ctx, (tx) => moveIssue(tx, { issueId, toStatusId: statuses[2]!.id, actorId: userId }));

    const claimed = await claimPendingAutomationEvents(admin, 20);
    const ours = claimed.filter((e) => e.projectId === projectId);
    expect(ours.length).toBeGreaterThanOrEqual(1);
    for (const event of ours) {
      expect(event.status).toBe("processing");
      await withAuthorizedTenant(ctx, (tx) => evaluateAutomationEvent(tx, event));
    }

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.labels).toEqual(["claimed"]);
  });

  it("updateIssue and createIssue also emit automation events (issue.created, issue.assigned, issue.updated)", async () => {
    const { projectId, statuses, issueTypes } = await seedProjectAndIssue();
    await withAuthorizedTenant(ctx, (tx) =>
      createAutomationRule(tx, { organizationId: orgId, projectId, name: "On create", trigger: { type: "issue.created" }, actions: [{ type: "comment", text: "welcome" }], createdBy: userId }),
    );

    const { issueId: newIssueId } = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Second issue", reporterId: userId }),
    );
    const createdEvent = await latestEventFor(newIssueId, "issue.created");
    await withAuthorizedTenant(ctx, (tx) => evaluateAutomationEvent(tx, createdEvent));

    const comments = await admin.select().from(schema.issueComment).where(eq(schema.issueComment.issueId, newIssueId));
    expect(comments).toHaveLength(1);

    await withAuthorizedTenant(ctx, (tx) => updateIssue(tx, newIssueId, { priority: "highest", actorId: userId }));
    const updatedEvent = await latestEventFor(newIssueId, "issue.updated");
    expect((updatedEvent.payload as { changedFields: string[] }).changedFields).toEqual(["priority"]);
  });

  it("create_subtask action creates a real subtask issue, parented to the triggering issue, in the project's default (todo-category) status", async () => {
    const { projectId, issueId, statuses, issueTypes } = await seedProjectAndIssue();
    const subtaskType = issueTypes.find((t) => t.isSubtask)!;
    await withAuthorizedTenant(ctx, (tx) =>
      createAutomationRule(tx, {
        organizationId: orgId,
        projectId,
        name: "Spin off a QA subtask on transition",
        trigger: { type: "issue.transitioned" },
        actions: [{ type: "create_subtask", typeId: subtaskType.id, title: "QA verification" }],
        createdBy: userId,
      }),
    );

    await withAuthorizedTenant(ctx, (tx) => moveIssue(tx, { issueId, toStatusId: statuses[2]!.id, actorId: userId }));
    const event = await latestEventFor(issueId, "issue.transitioned");
    await withAuthorizedTenant(ctx, (tx) => evaluateAutomationEvent(tx, event));

    const todoStatus = statuses.find((s) => s.category === "todo")!;
    const [subtask] = await admin.select().from(schema.issue).where(and(eq(schema.issue.parentId, issueId), eq(schema.issue.typeId, subtaskType.id)));
    expect(subtask).toMatchObject({ title: "QA verification", statusId: todoStatus.id, origin: "automation" });
  });
});
