import { eq, or, schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

export type IssueLinkType = "blocks" | "relates" | "duplicates" | "clones";

export interface LinkIssuesInput {
  fromIssueId: string;
  toIssueId: string;
  type: IssueLinkType;
}

/** Directional (fromIssueId "blocks" toIssueId, not symmetric) — matching JIRA's own issuelinks model, which the importer maps directly onto this. */
export async function linkIssues(tx: Tx, input: LinkIssuesInput) {
  const linkId = id("ilink");
  await tx.insert(schema.issueLink).values({ id: linkId, fromIssueId: input.fromIssueId, toIssueId: input.toIssueId, type: input.type });
  return { linkId };
}

/** Every link touching this issue, from either side. */
export async function listIssueLinks(tx: Tx, issueId: string) {
  return tx
    .select()
    .from(schema.issueLink)
    .where(or(eq(schema.issueLink.fromIssueId, issueId), eq(schema.issueLink.toIssueId, issueId)));
}
