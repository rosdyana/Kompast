import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { linkEntities, unlinkEntities, listOutgoingLinks, listBacklinks, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolvePage, resolveIssue } from "@/lib/api-resolvers";

const linkSchema = z.object({ issueKey: z.string().min(1) });

export const Route = createFileRoute("/api/v1/pages/$pageId/links")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "pages:read", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            await resolvePage(tx, ctx, params.pageId, "view");
            const [outgoing, backlinks] = await Promise.all([
              listOutgoingLinks(tx, "page", params.pageId),
              listBacklinks(tx, "page", params.pageId),
            ]);
            return jsonResponse({
              linkedIssueIds: outgoing.filter((l) => l.toType === "issue").map((l) => l.toId),
              mentionedBy: backlinks.filter((l) => l.fromType === "page").map((l) => l.fromId),
            });
          });
        }),

      POST: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "pages:write", "api");
          const body = linkSchema.parse(await request.json());

          return withAuthorizedTenant(ctx, async (tx) => {
            await resolvePage(tx, ctx, params.pageId, "edit");
            const { issue } = await resolveIssue(tx, ctx.organizationId, body.issueKey);
            await linkEntities(tx, {
              organizationId: ctx.organizationId,
              fromType: "page",
              fromId: params.pageId,
              toType: "issue",
              toId: issue.id,
              createdBy: ctx.userId,
            });
            return jsonResponse({ ok: true }, 201);
          });
        }),

      DELETE: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "pages:write", "api");
          const url = new URL(request.url);
          const issueKey = url.searchParams.get("issueKey");
          if (!issueKey) return jsonResponse({ ok: false }, 400);

          return withAuthorizedTenant(ctx, async (tx) => {
            await resolvePage(tx, ctx, params.pageId, "edit");
            const { issue } = await resolveIssue(tx, ctx.organizationId, issueKey);
            await unlinkEntities(tx, { fromType: "page", fromId: params.pageId, toType: "issue", toId: issue.id });
            return jsonResponse({ ok: true });
          });
        }),
    },
  },
});
