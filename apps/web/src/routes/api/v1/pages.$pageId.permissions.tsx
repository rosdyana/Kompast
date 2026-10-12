import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { canManagePageAccess, getPageAccess, grantPageAccess, removePagePermission, withAuthorizedTenant } from "@kompast/core";
import { ApiError, requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolvePage } from "@/lib/api-resolvers";

const subjectSchema = z.object({ type: z.enum(["user", "team"]), id: z.string().min(1) });
const grantSchema = z.object({ subject: subjectSchema, role: z.enum(["view", "comment", "edit", "full"]) });

/**
 * Page access list — the same packages/core functions the doc page's Share
 * popover uses (getPageAccessFn/grantPageAccessFn/revokePageAccessFn in
 * apps/web/src/lib/server-fns/pages.ts), so who-can-change-access can't
 * drift between UI, REST, and MCP. Empty `grants` = open to everyone who can
 * see the page's space.
 */
export const Route = createFileRoute("/api/v1/pages/$pageId/permissions")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "pages:read", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            await resolvePage(tx, ctx, params.pageId, "view");
            const { grants } = await getPageAccess(tx, params.pageId, ctx);
            return jsonResponse({ restricted: grants.length > 0, grants });
          });
        }),

      PUT: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "pages:write", "api");
          const body = grantSchema.parse(await request.json());
          return withAuthorizedTenant(ctx, async (tx) => {
            await resolvePage(tx, ctx, params.pageId, "view");
            if (!(await canManagePageAccess(tx, params.pageId, ctx))) throw new ApiError(403, "Forbidden", "You can't change who has access to this page");
            await grantPageAccess(tx, { pageId: params.pageId, subject: body.subject, role: body.role, actorUserId: ctx.userId });
            return jsonResponse({ ok: true });
          });
        }),

      DELETE: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "pages:write", "api");
          const subject = subjectSchema.parse(await request.json());
          return withAuthorizedTenant(ctx, async (tx) => {
            await resolvePage(tx, ctx, params.pageId, "view");
            if (!(await canManagePageAccess(tx, params.pageId, ctx))) throw new ApiError(403, "Forbidden", "You can't change who has access to this page");
            await removePagePermission(tx, params.pageId, subject, ctx.userId);
            return jsonResponse({ ok: true });
          });
        }),
    },
  },
});
