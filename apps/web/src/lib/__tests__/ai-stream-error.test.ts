import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProviderError, AiNotConfiguredError, ForbiddenError } from "@kompast/core";
import { aiStreamErrorMessage } from "../ai-stream-error";

const FALLBACK = "The AI provider request failed";
const ADMIN = { isDeploymentAdmin: true };
const MEMBER = { isDeploymentAdmin: false };

function providerError(status: number) {
  return new AiProviderError(`Anthropic API error (${status}): secret upstream body`, { status, provider: "Anthropic", detail: "secret upstream body" });
}

describe("aiStreamErrorMessage", () => {
  beforeEach(() => {
    // The fallback path logs the full error on purpose; keep the test output quiet.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives a deployment admin the HTTP status and a pointer to Test connection, not the provider body", () => {
    const message = aiStreamErrorMessage(providerError(404), FALLBACK, ADMIN);

    expect(message).toBe(`${FALLBACK} (HTTP 404 — open Settings → AI and use "Test connection" for details)`);
    expect(message).not.toContain("secret upstream body");
  });

  it("points an embedding-provider failure at Settings → Embedding", () => {
    const err = new AiProviderError("Embedding provider error (401): nope", { status: 401, provider: "Embedding provider", detail: "nope", kind: "embedding" });
    expect(aiStreamErrorMessage(err, FALLBACK, ADMIN)).toBe(`${FALLBACK} (HTTP 401 — open Settings → Embedding and use "Test connection" for details)`);
  });

  it("keeps the plain fallback for everyone who is not the deployment admin", () => {
    expect(aiStreamErrorMessage(providerError(404), FALLBACK, MEMBER)).toBe(FALLBACK);
  });

  it("keeps the plain fallback when no context is passed", () => {
    expect(aiStreamErrorMessage(providerError(401), FALLBACK)).toBe(FALLBACK);
  });

  it("gives the admin the fallback alone for an unexpected plain Error, since only provider failures carry a status", () => {
    expect(aiStreamErrorMessage(new Error("socket hang up"), FALLBACK, ADMIN)).toBe(FALLBACK);
  });

  it("still logs the full error on the fallback path", () => {
    const err = providerError(500);
    aiStreamErrorMessage(err, FALLBACK, MEMBER);

    expect(console.error).toHaveBeenCalledWith("[ai-stream] request failed:", err);
  });

  it("returns user-facing errors unchanged for everyone, without logging them", () => {
    expect(aiStreamErrorMessage(new AiNotConfiguredError(), FALLBACK, MEMBER)).toBe(new AiNotConfiguredError().message);
    expect(aiStreamErrorMessage(new ForbiddenError("nope"), FALLBACK, ADMIN)).toBe("nope");
    expect(console.error).not.toHaveBeenCalled();
  });
});
