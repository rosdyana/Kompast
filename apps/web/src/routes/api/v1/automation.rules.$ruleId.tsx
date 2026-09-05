import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { deleteAutomationRule, withAuthorizedTenant } from "@kompast/core";
import { schema, eq } from "@kompast/db";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveAutomationRule } from "@/lib/api-resolvers";

const updateRuleSchema = z.object({ enabled: z.boolean().optional(), dryRun: z.boolean().optional(), name: z.string().min(1).optional() });

export const Route = createFileRoute("/api/v1/automation/rules/$ruleId")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:read", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            const rule = await resolveAutomationRule(tx, ctx.organizationId, params.ruleId);
            return jsonResponse(rule);
          });
        }),

      PATCH: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:write", "api");
          const body = updateRuleSchema.parse(await request.json());

          return withAuthorizedTenant(ctx, async (tx) => {
            await resolveAutomationRule(tx, ctx.organizationId, params.ruleId);
            const patch: Partial<{ enabled: boolean; dryRun: boolean; name: string; updatedAt: Date }> = { updatedAt: new Date() };
            if (body.enabled !== undefined) patch.enabled = body.enabled;
            if (body.dryRun !== undefined) patch.dryRun = body.dryRun;
            if (body.name !== undefined) patch.name = body.name;
            await tx.update(schema.automationRule).set(patch).where(eq(schema.automationRule.id, params.ruleId));
            return jsonResponse({ ok: true });
          });
        }),

      DELETE: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:write", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            await resolveAutomationRule(tx, ctx.organizationId, params.ruleId);
            await deleteAutomationRule(tx, params.ruleId);
            return jsonResponse({ ok: true });
          });
        }),
    },
  },
});
