import * as z from "zod";
import { and, eq, inArray, schema } from "@kompast/db";
import type { Tx } from "@kompast/core";

/**
 * The JIRA base URL both legacy-import adapters accept. https only, like the
 * migration wizard's siteUrlSchema (server-fns/jira-migration.ts): the server
 * fetches this URL with the caller's credentials, so a plain-http or
 * internal URL would turn the import into a request-forgery tool.
 */
export const jiraBaseUrlSchema = z.url().refine((url) => url.startsWith("https://"), { message: "The JIRA site must start with https://" });

/** Largest single attachment the legacy importer will download. */
export const MAX_JIRA_ATTACHMENT_BYTES = 100 * 1024 * 1024;

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

/**
 * Attachment URLs come from the fetched JIRA JSON — i.e. from whatever
 * server `baseUrl` points at — so they are only trusted on that same
 * origin. No redirects (a 3xx could point anywhere, including internal
 * hosts), and the body is read with a running byte cap rather than
 * buffered whole.
 */
export function buildJiraAttachmentDownloader(email: string, apiToken: string, baseUrl: string) {
  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
  const allowedOrigin = new URL(baseUrl).origin;
  return async (url: string) => {
    if (new URL(url).origin !== allowedOrigin) throw new Error(`Attachment URL is not on the JIRA site (${allowedOrigin})`);
    const res = await fetch(url, { headers: { authorization: `Basic ${auth}` }, redirect: "manual" });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) throw new Error("JIRA attachment fetch was redirected; redirects are not followed");
    if (!res.ok) throw new Error(`JIRA attachment fetch failed (${res.status})`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_JIRA_ATTACHMENT_BYTES) throw new Error(`JIRA attachment is larger than ${MAX_JIRA_ATTACHMENT_BYTES} bytes`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_JIRA_ATTACHMENT_BYTES) {
          await reader.cancel();
          throw new Error(`JIRA attachment is larger than ${MAX_JIRA_ATTACHMENT_BYTES} bytes`);
        }
        chunks.push(value);
      }
    }
    return { data: Buffer.concat(chunks), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  };
}
