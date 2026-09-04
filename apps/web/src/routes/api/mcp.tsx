import { createFileRoute } from "@tanstack/react-router";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { requireApiAuth, ApiError } from "@/lib/api-auth";
import { buildMcpServer } from "@/lib/mcp-server";

/**
 * PAT-only, stateless Streamable HTTP (see plan §"MCP server — /mcp"):
 * no session ID, no SSE stream held open across requests — a fresh
 * McpServer + transport is built per POST, scoped to that one caller's
 * ctx, and torn down when the response is sent. That's what lets Caddy
 * front this with zero session affinity. GET/DELETE (session lifecycle
 * for *stateful* Streamable HTTP) have nothing to attach to here, so
 * they're not offered — Claude Code's http transport works fine
 * POST-only.
 */
export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let ctx;
        try {
          ctx = await requireApiAuth(request, undefined, "mcp");
        } catch (err) {
          if (err instanceof ApiError) return err.toResponse();
          throw err;
        }

        const server = buildMcpServer(ctx);
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        return transport.handleRequest(request);
      },

      GET: async () => new Response(null, { status: 405, headers: { Allow: "POST" } }),
      DELETE: async () => new Response(null, { status: 405, headers: { Allow: "POST" } }),
    },
  },
});
