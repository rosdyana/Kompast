import { describe, expect, it } from "vitest";
import { resolveTemplates, buildLoopContextFields, type ExpressionContext } from "../automation-expressions";

function ctx(overrides: Partial<ExpressionContext> = {}): ExpressionContext {
  return { trigger: {}, steps: {}, item: null, loop: {}, ...overrides };
}

describe("resolveTemplates", () => {
  it("returns non-string values unchanged", () => {
    expect(resolveTemplates(42, ctx())).toBe(42);
    expect(resolveTemplates(true, ctx())).toBe(true);
    expect(resolveTemplates(null, ctx())).toBe(null);
  });

  it("returns a plain string with no {{...}} unchanged", () => {
    expect(resolveTemplates("hello world", ctx())).toBe("hello world");
  });

  it("a whole-string expression returns the real typed value, not a stringified one", () => {
    const context = ctx({ trigger: { payload: { count: 3, tags: ["a", "b"], nested: { x: 1 } } } });
    expect(resolveTemplates("{{trigger.payload.count}}", context)).toBe(3);
    expect(resolveTemplates("{{trigger.payload.tags}}", context)).toEqual(["a", "b"]);
    expect(resolveTemplates("{{trigger.payload.nested}}", context)).toEqual({ x: 1 });
  });

  it("a partial-string expression stringifies non-string values into the surrounding text", () => {
    const context = ctx({ trigger: { payload: { priority: "high", count: 3 } } });
    expect(resolveTemplates("Priority is {{trigger.payload.priority}}!", context)).toBe("Priority is high!");
    expect(resolveTemplates("Count: {{trigger.payload.count}}", context)).toBe("Count: 3");
  });

  it("a missing path resolves to null (whole-match) or empty string (partial-match), never throws", () => {
    const context = ctx();
    expect(resolveTemplates("{{trigger.payload.missing}}", context)).toBe(null);
    expect(resolveTemplates("value: {{trigger.payload.missing}}", context)).toBe("value: ");
  });

  it("deep-walks nested arrays/objects in a config blob", () => {
    const context = ctx({ trigger: { payload: { name: "Alice" } } });
    const config = { text: "Hi {{trigger.payload.name}}", tags: ["{{trigger.payload.name}}", "static"], nested: { greeting: "Hello {{trigger.payload.name}}" } };
    expect(resolveTemplates(config, context)).toEqual({
      text: "Hi Alice",
      tags: ["Alice", "static"],
      nested: { greeting: "Hello Alice" },
    });
  });

  it("resolves {{steps.<name>.output...}} against prior step output", () => {
    const context = ctx({ steps: { "find-issues": { output: { issueIds: ["i1", "i2"] } } } });
    expect(resolveTemplates("{{steps.find-issues.output.issueIds}}", context)).toEqual(["i1", "i2"]);
  });

  it("resolves {{item}} and {{loop.<key>.}} against the loop context fields", () => {
    const frames = [
      { loopKey: "outer", index: 0, item: "outer-item", itemType: "value" as const },
      { loopKey: "inner", index: 1, item: "inner-item", itemType: "value" as const },
    ];
    const context = ctx(buildLoopContextFields(frames));
    expect(resolveTemplates("{{item}}", context)).toBe("inner-item");
    expect(resolveTemplates("{{loop.outer}}", context)).toBe("outer-item");
    expect(resolveTemplates("{{loop.inner}}", context)).toBe("inner-item");
  });
});

describe("buildLoopContextFields", () => {
  it("returns null item and empty loop map with no frames", () => {
    expect(buildLoopContextFields([])).toEqual({ item: null, loop: {} });
  });
});
