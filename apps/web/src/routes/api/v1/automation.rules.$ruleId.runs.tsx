import { createFileRoute } from "@tanstack/react-router";
import { listAutomationRuns, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveAutomationRule } from "@/lib/api-resolvers";

export const Route = createFileRoute("/api/v1/automation/rules/$ruleId/runs")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:read", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            const rule = await resolveAutomationRule(tx, ctx.organizationId, params.ruleId);
            const runs = await listAutomationRuns(tx, rule.id);
            return jsonResponse({ data: runs });
          });
        }),
    },
  },
});
