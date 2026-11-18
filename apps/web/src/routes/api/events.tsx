import { createFileRoute } from "@tanstack/react-router";
import { ApiError, requireSessionAuth } from "@/lib/api-auth";
import { subscribeShellChanges } from "@/lib/shell-events";

/** Comment line every 25s: keeps proxies/load balancers from closing an idle stream (most cut at 60s). */
const HEARTBEAT_MS = 25_000;

/**
 * Server-sent events for the live sidebar: one `shell` event whenever this
 * workspace's pages/projects/teams change (packages/db/realtime.sql). The
 * event carries no data — the browser re-runs its /_app loader, which reads
 * through RLS as that user, so nobody learns about anything they can't see.
 * Session-cookie auth only (UI, not a REST/MCP surface), like /api/ai/stream.
 * A reverse proxy must not buffer this response: Caddy flushes
 * text/event-stream on its own; nginx honours X-Accel-Buffering below.
 */
export const Route = createFileRoute("/api/events")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let ctx;
        try {
          ctx = await requireSessionAuth(request);
        } catch (err) {
          if (err instanceof ApiError) return err.toResponse();
          throw err;
        }

        const encoder = new TextEncoder();
        let cleanup = () => {};
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const write = (chunk: string) => {
              try {
                controller.enqueue(encoder.encode(chunk));
              } catch {
                cleanup(); // stream already closed
              }
            };
            // retry: how long EventSource waits before reconnecting after a drop.
            write("retry: 5000\n: connected\n\n");
            const unsubscribe = subscribeShellChanges(ctx.organizationId, () => write("event: shell\ndata: {}\n\n"));
            const heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
            let done = false;
            cleanup = () => {
              if (done) return;
              done = true;
              clearInterval(heartbeat);
              unsubscribe();
              request.signal.removeEventListener("abort", cleanup);
              try {
                controller.close();
              } catch {
                // already closed
              }
            };
            request.signal.addEventListener("abort", cleanup);
          },
          cancel() {
            cleanup();
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          },
        });
      },
    },
  },
});
