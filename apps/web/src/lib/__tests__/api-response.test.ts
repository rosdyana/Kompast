import { describe, expect, it } from "vitest";
import { ConflictError, InvalidInputError, NotFoundError } from "@kompast/core";
import { handleApiRoute } from "../api-response";

/**
 * The shared resolvers in packages/core throw these classes instead of the
 * web-only ApiError. handleApiRoute must keep answering REST callers with the
 * same status and title they got before the move.
 */
describe("handleApiRoute maps packages/core lookup errors to RFC 9457 responses", () => {
  it.each([
    ["NotFoundError", new NotFoundError("Project QA not found"), 404, "Not Found"],
    ["ConflictError", new ConflictError('Project key "qa" is ambiguous'), 409, "Conflict"],
    ["InvalidInputError", new InvalidInputError('"KPT" is not a valid issue key'), 400, "Bad Request"],
  ])("%s -> %i %s", async (_name, err, status, title) => {
    const res = await handleApiRoute(() => Promise.reject(err));
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ status, title, detail: err.message });
  });
});
