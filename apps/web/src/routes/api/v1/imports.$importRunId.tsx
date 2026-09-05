import { createFileRoute } from "@tanstack/react-router";
import { withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveImportRun } from "@/lib/api-resolvers";

export const Route = createFileRoute("/api/v1/imports/$importRunId")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:read", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            const run = await resolveImportRun(tx, ctx.organizationId, params.importRunId);
            return jsonResponse(run);
          });
        }),
    },
  },
});
