import { and, desc, eq, ilike, or, schema } from "@kompast/db";
import type { Tx } from "./types";

export interface WorkspaceSearchResult {
  issues: Array<{ id: string; projectKey: string; keySeq: number; title: string; statusName: string }>;
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
      })
      .from(schema.issue)
      .innerJoin(schema.project, eq(schema.project.id, schema.issue.projectId))
      .innerJoin(schema.workflowStatus, eq(schema.workflowStatus.id, schema.issue.statusId))
      .where(
        and(
          eq(schema.issue.organizationId, organizationId),
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
