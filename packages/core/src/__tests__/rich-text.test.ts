import { describe, expect, it } from "vitest";
import { toPlainText } from "../rich-text";

describe("toPlainText", () => {
  it("returns empty string for null/undefined", () => {
    expect(toPlainText(null)).toBe("");
    expect(toPlainText(undefined)).toBe("");
  });

  it("returns empty string for an empty object (no text field)", () => {
    expect(toPlainText({})).toBe("");
  });

  it("returns empty string for malformed input that isn't an array or {text} object", () => {
    expect(toPlainText("just a string" as unknown as never)).toBe("");
    expect(toPlainText(42 as unknown as never)).toBe("");
    expect(toPlainText(true as unknown as never)).toBe("");
  });

  it("extracts the legacy { text: string } shape", () => {
    expect(toPlainText({ text: "hello" })).toBe("hello");
  });

  it("ignores a { text } field that isn't a string", () => {
    expect(toPlainText({ text: 123 } as unknown as never)).toBe("");
  });

  it("extracts a flat BlockNote Block[] array, joining blocks with newlines", () => {
    const blocks = [
      { type: "paragraph", content: [{ type: "text", text: "First paragraph." }] },
      { type: "paragraph", content: [{ type: "text", text: "Second paragraph." }] },
    ];
    expect(toPlainText(blocks)).toBe("First paragraph.\nSecond paragraph.");
  });

  it("joins multiple inline text nodes within a single block's content with no separator", () => {
    const blocks = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
    ];
    expect(toPlainText(blocks)).toBe("Hello world");
  });

  it("extracts nested children text, joined under the parent block's own text", () => {
    const blocks = [
      {
        type: "bulletListItem",
        content: [{ type: "text", text: "Parent item" }],
        children: [
          { type: "bulletListItem", content: [{ type: "text", text: "Child item 1" }] },
          { type: "bulletListItem", content: [{ type: "text", text: "Child item 2" }] },
        ],
      },
    ];
    expect(toPlainText(blocks)).toBe("Parent item\nChild item 1\nChild item 2");
  });

  it("skips non-text inline content (e.g. links/mentions represented as non-text nodes)", () => {
    const blocks = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "See " },
          { type: "mention", id: "user-1" },
        ],
      },
    ];
    expect(toPlainText(blocks as unknown as never)).toBe("See ");
  });

  it("returns empty string for an empty array", () => {
    expect(toPlainText([])).toBe("");
  });

  it("handles malformed blocks (null entries, non-object entries, missing content/children) without throwing", () => {
    const blocks = [null, "not-a-block", 42, { type: "paragraph" }, { type: "paragraph", content: "not-an-array" }, { type: "paragraph", children: "not-an-array" }];
    expect(() => toPlainText(blocks as unknown as never)).not.toThrow();
    expect(toPlainText(blocks as unknown as never)).toBe("");
  });

  it("handles a block whose content array contains malformed entries without throwing", () => {
    const blocks = [{ type: "paragraph", content: [null, 42, "not-an-object", { type: "text" }, { text: "no type field" }] }];
    expect(() => toPlainText(blocks as unknown as never)).not.toThrow();
    // { type: "text" } with no `text` field -> "" (via String(undefined ?? "")); others contribute "".
    expect(toPlainText(blocks as unknown as never)).toBe("");
  });
});
