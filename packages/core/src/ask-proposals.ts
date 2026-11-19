import { eq, schema, type Json } from "@kompast/db";
import { withAuthorizedTenant, type AuthContext } from "./permissions";
import { ConflictError, NotFoundError } from "./errors";
import type { Tx } from "./types";
import type { AskProposal } from "./ask-tools";
import { createIssue } from "./issue";
import { addComment } from "./comment";
import { createPage } from "./page";
import { paragraphDoc } from "./rich-text";

/** Who the mutations are attributed to, on every row they write. */
const ORIGIN = "ai" as const;
const ORIGIN_CLIENT = "ask-kompast";

export interface AskProposalDeps {
  /** Seeds a brand-new page's body from Markdown. Lives in apps/web (it needs jsdom), so core takes it as a callback. */
  seedPageBody?: (tx: Tx, pageId: string, markdown: string, organizationId: string) => Promise<void>;
}

/** Loads the message's proposals under a row lock, so two Apply clicks (or Apply racing Discard) serialize. */
async function lockProposals(tx: Tx, messageId: string) {
  const [message] = await tx.select().from(schema.aiMessage).where(eq(schema.aiMessage.id, messageId)).for("update");
  // RLS hides other users' threads, so "not found" also covers "not yours".
  if (!message) throw new NotFoundError("That message could not be found");
  const proposals = Array.isArray(message.proposals) ? (message.proposals as unknown as AskProposal[]) : [];
  return { proposals };
}

async function saveProposals(tx: Tx, messageId: string, proposals: AskProposal[]) {
  await tx
    .update(schema.aiMessage)
    .set({ proposals: proposals as unknown as Json })
    .where(eq(schema.aiMessage.id, messageId));
}

/** Re-checks visibility of the project under RLS, so a proposal drafted while the user could see a project still fails once they can't. */
async function visibleProject(tx: Tx, projectId: string) {
  const [project] = await tx.select().from(schema.project).where(eq(schema.project.id, projectId));
  if (!project) throw new NotFoundError("That project could not be found");
  return project;
}

/** Runs the mutation a proposal describes, inside the caller's transaction. Any throw rolls the whole Apply back. */
async function runProposal(tx: Tx, ctx: AuthContext, deps: AskProposalDeps, proposal: AskProposal): Promise<NonNullable<AskProposal["result"]>> {
  const input = proposal.input;

  switch (proposal.kind) {
    case "create_issue": {
      const project = await visibleProject(tx, input.projectId as string);
      const created = await createIssue(tx, {
        organizationId: ctx.organizationId,
        projectId: project.id,
        typeId: input.typeId as string,
        statusId: input.statusId as string,
        title: input.title as string,
        reporterId: ctx.userId,
        assigneeId: (input.assigneeId as string | null) ?? undefined,
        priority: (input.priority as string | null) ?? undefined,
        descriptionJson: typeof input.description === "string" ? paragraphDoc(input.description) : undefined,
        origin: ORIGIN,
        originClient: ORIGIN_CLIENT,
      });
      return {
        issueId: created.issueId,
        issueKey: `${project.key}-${created.keySeq}`,
        projectKey: project.key,
        keySeq: created.keySeq,
        teamId: project.teamId,
      };
    }

    case "add_comment": {
      const [row] = await tx
        .select({ issue: schema.issue, projectKey: schema.project.key, teamId: schema.project.teamId })
        .from(schema.issue)
        .innerJoin(schema.project, eq(schema.project.id, schema.issue.projectId))
        .where(eq(schema.issue.id, input.issueId as string));
      if (!row) throw new NotFoundError("That issue could not be found");
      const { commentId } = await addComment(tx, {
        issueId: row.issue.id,
        authorId: ctx.userId,
        bodyJson: paragraphDoc(input.body as string),
        origin: ORIGIN,
        originClient: ORIGIN_CLIENT,
      });
      return {
        commentId,
        issueId: row.issue.id,
        issueKey: `${row.projectKey}-${row.issue.keySeq}`,
        projectKey: row.projectKey,
        keySeq: row.issue.keySeq,
        teamId: row.teamId,
      };
    }

    case "create_page": {
      const projectId = (input.projectId as string | null) ?? null;
      if (projectId) await visibleProject(tx, projectId);
      const isPrivate = input.private === true;
      const page = await createPage(tx, {
        organizationId: ctx.organizationId,
        title: input.title as string,
        projectId,
        privateOwnerId: isPrivate ? ctx.userId : undefined,
        actorUserId: ctx.userId,
      });
      if (typeof input.content === "string" && input.content && deps.seedPageBody) {
        await deps.seedPageBody(tx, page.id, input.content, ctx.organizationId);
      }
      return { pageId: page.id };
    }
  }
}

/**
 * Approves a drafted change: runs its mutation through core (origin "ai") and marks the proposal applied, all in
 * one transaction with the message row locked. Applying an already-applied proposal returns it unchanged (no second
 * write); a discarded one is a conflict. If the mutation throws, nothing is written and the proposal stays pending.
 */
export async function applyAskProposal(ctx: AuthContext, input: { messageId: string; proposalId: string }, deps: AskProposalDeps = {}): Promise<AskProposal> {
  return withAuthorizedTenant(ctx, async (tx) => {
    const { proposals } = await lockProposals(tx, input.messageId);
    const index = proposals.findIndex((p) => p.id === input.proposalId);
    if (index < 0) throw new NotFoundError("That change could not be found");

    const current = proposals[index]!;
    if (current.status === "applied") return current;
    if (current.status === "discarded") throw new ConflictError("This change was discarded, so it can no longer be applied");

    const result = await runProposal(tx, ctx, deps, current);
    const applied: AskProposal = { ...current, status: "applied", result };
    proposals[index] = applied;
    await saveProposals(tx, input.messageId, proposals);
    return applied;
  });
}

/** Declines a drafted change. Pending becomes discarded; an already-applied change can't be undone here, so it's a conflict. */
export async function discardAskProposal(ctx: AuthContext, input: { messageId: string; proposalId: string }): Promise<AskProposal> {
  return withAuthorizedTenant(ctx, async (tx) => {
    const { proposals } = await lockProposals(tx, input.messageId);
    const index = proposals.findIndex((p) => p.id === input.proposalId);
    if (index < 0) throw new NotFoundError("That change could not be found");

    const current = proposals[index]!;
    if (current.status === "discarded") return current;
    if (current.status === "applied") throw new ConflictError("This change was already applied and cannot be discarded");

    const discarded: AskProposal = { ...current, status: "discarded" };
    proposals[index] = discarded;
    await saveProposals(tx, input.messageId, proposals);
    return discarded;
  });
}
