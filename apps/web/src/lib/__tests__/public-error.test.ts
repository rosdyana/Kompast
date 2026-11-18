import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notFound, redirect } from "@tanstack/react-router";
import { APIError as BetterAuthAPIError } from "better-auth/api";
import { ConflictError, DisallowedOutboundUrlError, ForbiddenError, NotFoundError, UserFacingError } from "@kompast/core";
import { classifyError, GENERIC_ERROR_PREFIX, newErrorReference, toPublicError } from "../public-error";

describe("classifyError", () => {
  it("keeps the message and status of caller-facing errors", () => {
    expect(classifyError(new NotFoundError("Project QA not found"))).toEqual({ status: 404, title: "Not Found", message: "Project QA not found" });
    expect(classifyError(new ForbiddenError("nope"))).toMatchObject({ status: 403, message: "nope" });
    expect(classifyError(new ConflictError("taken"))).toMatchObject({ status: 409, message: "taken" });
    expect(classifyError(new UserFacingError("Too many attempts. Try again in 5 minutes."))).toEqual({
      status: 400,
      title: "Bad Request",
      message: "Too many attempts. Try again in 5 minutes.",
    });
  });

  it("keeps outbound-URL guard and Better Auth 4xx messages; Better Auth 5xx stays internal", () => {
    expect(classifyError(new DisallowedOutboundUrlError("Only http(s) URLs are allowed"))).toMatchObject({ status: 400, message: "Only http(s) URLs are allowed" });
    expect(classifyError(new BetterAuthAPIError("BAD_REQUEST", { message: "User is already a member of this organization" }))).toEqual({
      status: 400,
      title: "Bad request",
      message: "User is already a member of this organization",
    });
    expect(classifyError(new BetterAuthAPIError("INTERNAL_SERVER_ERROR", { message: "db exploded" }))).toBeNull();
  });

  it("returns null for an internal error", () => {
    expect(classifyError(new Error('relation "x" does not exist'))).toBeNull();
  });
});

describe("toPublicError", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replaces an internal error with the generic text and a reference", () => {
    const out = toPublicError(new Error('relation "x" does not exist'));
    expect(out).toBeInstanceOf(Error);
    const message = (out as Error).message;
    expect(message.startsWith(GENERIC_ERROR_PREFIX)).toBe(true);
    expect(message).toMatch(/^Something went wrong\. Reference: [A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(message).not.toContain("relation");
    expect(console.error).toHaveBeenCalled();
  });

  it("passes a known error through unchanged", () => {
    const err = new UserFacingError("Setup has already run.");
    expect(toPublicError(err)).toBe(err);
  });

  it("passes redirect() and notFound() through as the same object", () => {
    const r = redirect({ to: "/" });
    const n = notFound();
    expect(toPublicError(r)).toBe(r);
    expect(toPublicError(n)).toBe(n);
  });
});

describe("newErrorReference", () => {
  it("formats 8 unambiguous characters as XXXX-XXXX", () => {
    for (let i = 0; i < 50; i++) expect(newErrorReference()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
});
