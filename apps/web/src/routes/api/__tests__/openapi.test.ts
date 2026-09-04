import { describe, expect, it } from "vitest";
import { Route as OpenApiRoute } from "../openapi";
import { Route as DocsRoute } from "../docs";

type Handler = (opts: { request: Request; params: Record<string, string> }) => Promise<Response>;

describe("/api/openapi and /api/docs", () => {
  it("serves a valid OpenAPI 3.1 document describing the v1 routes", async () => {
    const handler = OpenApiRoute.options.server!.handlers as { GET: Handler };
    const res = await handler.GET({ request: new Request("http://x/api/openapi"), params: {} });
    expect(res.headers.get("content-type")).toContain("application/json");
    const spec = await res.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/issues",
        "/api/v1/issues/{issueKey}",
        "/api/v1/pages",
        "/api/v1/pages/{pageId}",
        "/api/v1/search",
      ]),
    );
  });

  it("serves an HTML page embedding Scalar pointed at /api/openapi", async () => {
    const handler = DocsRoute.options.server!.handlers as { GET: Handler };
    const res = await handler.GET({ request: new Request("http://x/api/docs"), params: {} });
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('data-url="/api/openapi"');
  });
});
