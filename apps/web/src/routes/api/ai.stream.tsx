import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { runDocTextAction, generateIssueDescription, generateSprintSummary, withAuthorizedTenant } from "@kompast/core";
import { ApiError, requireSessionAuth } from "@/lib/api-auth";

const bodySchema = z.discriminatedUnion("feature", [
  z.object({
    feature: z.literal("doc"),
    action: z.enum(["continue", "improve", "shorten", "expand", "summarize", "translate"]),
    text: z.string().min(1),
    targetLanguage: z.string().optional(),
  }),
  z.object({
    feature: z.literal("issue-description"),
    title: z.string().min(1),
    context: z.string().optional(),
  }),
  z.object({
    feature: z.literal("sprint-summary"),
    sprintId: z.string(),
  }),
]);

/**
 * A UI-only AI streaming endpoint — session-cookie auth, not a REST/MCP
 * surface (no PAT support, no api-response.ts problem+json envelope). AI
 * features aren't exposed to REST/MCP this pass — see README's P7 section
 * for that scope cut. Emits `data: {delta}` frames as text arrives, then
 * one final `data: {done:true}` frame; a mid-stream failure (including
 * "AI not configured") emits `data: {error}` instead of an HTTP-level
 * error, since by the time any text has streamed the response's status
 * code is already committed.
 */
export const Route = createFileRoute("/api/ai/stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let ctx;
        try {
          ctx = await requireSessionAuth(request);
        } catch (err) {
          if (err instanceof ApiError) return err.toResponse();
          throw err;
        }

        const parsed = bodySchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return new ApiError(400, "Bad Request", parsed.error.message).toResponse();
        }
        const body = parsed.data;

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (frame: Record<string, unknown>) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
            try {
              await withAuthorizedTenant(ctx, async (tx) => {
                const onDelta = (delta: string) => send({ delta });
                if (body.feature === "doc") {
                  await runDocTextAction(tx, { organizationId: ctx.organizationId, userId: ctx.userId, action: body.action, text: body.text, targetLanguage: body.targetLanguage, onDelta });
                } else if (body.feature === "issue-description") {
                  await generateIssueDescription(tx, { organizationId: ctx.organizationId, userId: ctx.userId, title: body.title, context: body.context, onDelta });
                } else {
                  await generateSprintSummary(tx, { organizationId: ctx.organizationId, userId: ctx.userId, sprintId: body.sprintId, onDelta });
                }
              });
              send({ done: true });
            } catch (err) {
              send({ error: err instanceof Error ? err.message : "AI request failed" });
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
      },

      GET: async () => new Response(null, { status: 405, headers: { Allow: "POST" } }),
    },
  },
});
