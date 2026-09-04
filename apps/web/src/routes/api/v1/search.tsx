import { createFileRoute } from "@tanstack/react-router";
import { searchWorkspace, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";

export const Route = createFileRoute("/api/v1/search")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:read", "api");
          const url = new URL(request.url);
          const q = url.searchParams.get("q") ?? "";
          const limitParam = url.searchParams.get("limit");
          const limit = limitParam ? Math.min(Math.max(Number(limitParam) || 8, 1), 50) : undefined;

          return withAuthorizedTenant(ctx, async (tx) => {
            const result = await searchWorkspace(tx, ctx.organizationId, q, limit);
            return jsonResponse(result);
          });
        }),
    },
  },
});
