import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { askKompast, isDeploymentAdmin } from "@kompast/core";
import { db } from "@kompast/db";
import { ApiError, requireSessionAuth } from "@/lib/api-auth";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { aiStreamErrorMessage } from "@/lib/ai-stream-error";

const bodySchema = z.object({
  threadId: z.string().max(128).optional(),
  question: z.string().min(1).max(4_000),
});

/**
 * Same shape as /api/ai/stream (session-cookie auth, UI-only, not a
 * REST/MCP surface) — see that route's own doc comment for the reasoning.
 * The final frame here also carries `threadId` (so a first message can
 * report back which thread was created) and `citations`.
 */
export const Route = createFileRoute("/api/ask/stream")({
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

        const limit = await rateLimit(`ai:${ctx.userId}`, 30, 60);
        if (!limit.ok) return tooManyRequests(limit.retryAfter);

        const parsed = bodySchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return new ApiError(400, "Bad Request", parsed.error.message).toResponse();
        }
        const body = parsed.data;

        // Once per request, and never allowed to break the response: a failed lookup just means "not an admin".
        const isAdmin = await isDeploymentAdmin(db, ctx.userId).catch(() => false);

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (frame: Record<string, unknown>) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
            try {
              // askKompast manages its own short transactions; no transaction is held open while the answer streams.
              const result = await askKompast(ctx, {
                threadId: body.threadId,
                question: body.question,
                onDelta: (delta) => send({ delta }),
                // A tool frame tells the UI which lookup is running; the client shows it as a transient status.
                onTool: (tool) => send({ tool }),
                // A proposal frame carries a drafted change the user can Apply or Discard once the answer is saved (the done frame's messageId).
                onProposal: (proposal) => send({ proposal }),
              });
              send({ done: true, threadId: result.threadId, messageId: result.messageId, citations: result.citations });
            } catch (err) {
              send({ error: aiStreamErrorMessage(err, "The AI provider request failed", { isDeploymentAdmin: isAdmin }) });
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
