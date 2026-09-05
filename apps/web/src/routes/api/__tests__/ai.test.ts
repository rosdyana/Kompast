import { describe, expect, it } from "vitest";
import { Route } from "../ai.stream";

type Handler = (opts: { request: Request; params: Record<string, string> }) => Promise<Response>;
const handlers = Route.options.server!.handlers as { GET: Handler; POST: Handler };

/**
 * This route is session-cookie-gated (see requireSessionAuth in
 * lib/api-auth.ts), not PAT-based like every /api/v1 route — so unlike
 * those, there's no way to forge a valid caller here without a real
 * Entra ID login (this repo has no dev credential-login bypass — see
 * README "First run: /setup"). What IS testable without one: the
 * unauthenticated-rejection and method-not-allowed paths. The actual
 * authenticated streaming logic (prompt building, token usage, ai_usage
 * logging) is covered end-to-end with a mocked provider in
 * packages/core/src/__tests__/settings.test.ts's "packages/core/ai"
 * describe block — this route is a thin session-auth + SSE-framing
 * adapter over that already-tested service layer.
 */
describe("/api/ai/stream", () => {
  it("GET is not allowed", async () => {
    const res = await handlers.GET({ request: new Request("http://x/api/ai/stream"), params: {} });
    expect(res.status).toBe(405);
  });

  it("rejects a request with no session cookie", async () => {
    const res = await handlers.POST({
      request: new Request("http://x/api/ai/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ feature: "doc", action: "improve", text: "hi" }) }),
      params: {},
    });
    expect(res.status).toBe(401);
  });
});
