import { createFileRoute } from "@tanstack/react-router";
import { buildOpenApiSpec } from "@/lib/openapi-spec";

export const Route = createFileRoute("/api/openapi")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const spec = buildOpenApiSpec(new URL(request.url).origin);
        return new Response(JSON.stringify(spec), { headers: { "Content-Type": "application/json" } });
      },
    },
  },
});
