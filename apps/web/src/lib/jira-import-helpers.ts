import { and, eq, inArray, schema } from "@kompast/db";
import type { Tx } from "@kompast/core";

/**
 * Matches JIRA users to existing Kompast members by email, once per
 * distinct email in a batch — this codebase has no directory sync, so an
 * unmatched JIRA user's issues simply fall back to the importing caller
 * as reporter/assignee-less. Shared by the REST endpoint (api/v1/imports)
 * and the UI server function (server-fns/imports) — same lookup either way.
 */
export async function resolveEmailsToUserIds(tx: Tx, organizationId: string, emails: string[]): Promise<Map<string, string>> {
  if (emails.length === 0) return new Map();
  const rows = await tx
    .select({ id: schema.user.id, email: schema.user.email })
    .from(schema.user)
    .innerJoin(schema.member, eq(schema.member.userId, schema.user.id))
    .where(and(eq(schema.member.organizationId, organizationId), inArray(schema.user.email, emails)));
  return new Map(rows.map((r) => [r.email.toLowerCase(), r.id]));
}

export function buildJiraAttachmentDownloader(email: string, apiToken: string) {
  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
  return async (url: string) => {
    const res = await fetch(url, { headers: { authorization: `Basic ${auth}` } });
    if (!res.ok) throw new Error(`JIRA attachment fetch failed (${res.status})`);
    return { data: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  };
}
