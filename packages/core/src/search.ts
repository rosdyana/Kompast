import { and, desc, eq, ilike, isNull, or, schema } from "@kompast/db";
import type { Tx } from "./types";
import { getProjectByTeamAndKey } from "./project";

export interface WorkspaceSearchResult {
  issues: Array<{
    id: string;
    projectKey: string;
    keySeq: number;
    title: string;
    statusName: string;
    teamId: string | null;
    teamName: string | null;
  }>;
  people: Array<{ id: string; name: string; email: string }>;
}

/**
 * Scoped to issues + people for now — page search (title/body/embedding)
 * joins in once P2 (Docs) exists. Trigram ILIKE rather than tsvector FTS:
 * titles mix Indonesian and English freely, and trigram handles substring
 * matches with no per-language tokenizer to get wrong.
 */
export async function searchWorkspace(
  tx: Tx,
  organizationId: string,
  queryText: string,
  limit = 8,
): Promise<WorkspaceSearchResult> {
  const q = queryText.trim();
  if (q.length < 2) return { issues: [], people: [] };

  const keyMatch = /^([a-zA-Z]+)-(\d+)$/.exec(q);

  const [issues, people] = await Promise.all([
    tx
      .select({
        id: schema.issue.id,
        keySeq: schema.issue.keySeq,
        title: schema.issue.title,
        projectKey: schema.project.key,
        statusName: schema.workflowStatus.name,
        teamId: schema.project.teamId,
        teamName: schema.team.name,
      })
      .from(schema.issue)
      .innerJoin(schema.project, eq(schema.project.id, schema.issue.projectId))
      .innerJoin(schema.workflowStatus, eq(schema.workflowStatus.id, schema.issue.statusId))
      .leftJoin(schema.team, eq(schema.team.id, schema.project.teamId))
      .where(
        and(
          eq(schema.issue.organizationId, organizationId),
          isNull(schema.issue.archivedAt),
          keyMatch
            ? or(
                ilike(schema.issue.title, `%${q}%`),
                and(ilike(schema.project.key, keyMatch[1]!), eq(schema.issue.keySeq, Number(keyMatch[2]))),
              )
            : ilike(schema.issue.title, `%${q}%`),
        ),
      )
      .orderBy(desc(schema.issue.updatedAt))
      .limit(limit),
    tx
      .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
      .from(schema.user)
      .innerJoin(schema.member, eq(schema.member.userId, schema.user.id))
      .where(and(eq(schema.member.organizationId, organizationId), ilike(schema.user.name, `%${q}%`)))
      .limit(limit),
  ]);

  return { issues, people };
}

export interface ResolvedIssueRef {
  issueId: string;
  projectKey: string;
  keySeq: number;
  teamId: string | null;
  title: string;
}

/**
 * Looks up the issue an issue URL points at (/issues/:teamId/:projectKey/:keySeq),
 * through the caller's tx so RLS decides visibility. Returns null when the
 * project or issue doesn't exist, is archived, or isn't visible to the caller,
 * so a pasted link to something the reader can't see never leaks its title.
 */
export async function resolveIssueRef(
  tx: Tx,
  input: { organizationId: string; teamId: string | null; projectKey: string; keySeq: number },
): Promise<ResolvedIssueRef | null> {
  // An ambiguous key (two projects on one team) throws in getProjectByTeamAndKey; for a paste that just means "can't resolve".
  const project = await getProjectByTeamAndKey(tx, { organizationId: input.organizationId, teamId: input.teamId, key: input.projectKey }).catch(() => null);
  if (!project) return null;
  const [issue] = await tx
    .select({ id: schema.issue.id, title: schema.issue.title })
    .from(schema.issue)
    .where(and(eq(schema.issue.projectId, project.id), eq(schema.issue.keySeq, input.keySeq), isNull(schema.issue.archivedAt)))
    .limit(1);
  if (!issue) return null;
  return { issueId: issue.id, projectKey: project.key, keySeq: input.keySeq, teamId: project.teamId, title: issue.title };
}
