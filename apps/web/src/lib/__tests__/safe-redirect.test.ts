import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "../safe-redirect";

describe("safeRedirectPath", () => {
  it("keeps same-origin paths", () => {
    expect(safeRedirectPath("/s/share_abc")).toBe("/s/share_abc");
    expect(safeRedirectPath("/docs/p1?x=1#h")).toBe("/docs/p1?x=1#h");
  });

  it("drops anything that could leave the origin", () => {
    for (const bad of ["//evil.test", "/\\evil.test", "https://evil.test", "evil.test", "javascript:alert(1)", "/\tevil", "", 42, undefined]) {
      expect(safeRedirectPath(bad)).toBeUndefined();
    }
  });
});
