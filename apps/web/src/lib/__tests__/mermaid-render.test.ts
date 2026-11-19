import { describe, it, expect, vi, afterEach } from "vitest";
import { isMermaidLanguage, debounce } from "../mermaid-render";

// mermaid itself is never imported here: it is browser-only and loaded lazily.

describe("isMermaidLanguage", () => {
  it("matches mermaid regardless of case and surrounding whitespace", () => {
    expect(isMermaidLanguage("mermaid")).toBe(true);
    expect(isMermaidLanguage("Mermaid")).toBe(true);
    expect(isMermaidLanguage("  MERMAID ")).toBe(true);
  });

  it("rejects other languages and empty values", () => {
    expect(isMermaidLanguage("typescript")).toBe(false);
    expect(isMermaidLanguage("mermaidx")).toBe(false);
    expect(isMermaidLanguage("")).toBe(false);
    expect(isMermaidLanguage(null)).toBe(false);
    expect(isMermaidLanguage(undefined)).toBe(false);
  });
});

describe("debounce", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once after the quiet period, with the latest arguments", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 400);

    d.call("a");
    vi.advanceTimersByTime(200);
    d.call("b");
    vi.advanceTimersByTime(399);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("b");
  });

  it("cancel prevents a pending call", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 400);

    d.call();
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});
