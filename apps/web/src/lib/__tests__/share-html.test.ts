import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { createServerSchema } from "../blocknote-schema";
import { sanitizeShareHtml } from "../share-html";

// The vitest environment is node, so parse the output with a throwaway jsdom.
function parse(html: string): HTMLElement {
  return new JSDOM(`<div id="root">${html}</div>`).window.document.getElementById("root")!;
}

describe("sanitizeShareHtml — hostile markup is inert", () => {
  it("removes the onerror handler from an image", () => {
    const out = sanitizeShareHtml('<img src=x onerror="alert(1)">');
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("alert(1)");
  });

  it("removes script elements entirely", () => {
    const out = sanitizeShareHtml("<p>hi</p><script>alert(1)</script>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("<p>hi</p>");
  });

  it("drops javascript: hrefs from anchors", () => {
    const out = sanitizeShareHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain(">click</a>");
  });

  it("drops obfuscated javascript: hrefs too", () => {
    const out = sanitizeShareHtml('<a href="  JaVa\tScRiPt:alert(1)">x</a>');
    expect(out.toLowerCase()).not.toContain("javascript");
  });

  it("drops relative and data: hrefs from anchors (only http(s)/mailto survive)", () => {
    const relative = sanitizeShareHtml('<a href="/api/v1/pages">x</a>');
    expect(relative).not.toContain("href=");
    const data = sanitizeShareHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    expect(data).not.toContain("data:");
  });

  it("removes iframe, object and embed elements", () => {
    const out = sanitizeShareHtml(
      '<iframe src="https://evil.example" srcdoc="<script>alert(1)</script>"></iframe>' +
        '<object data="https://evil.example/x.swf"></object><embed src="https://evil.example/x.swf">',
    );
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<object");
    expect(out).not.toContain("<embed");
    expect(out).not.toContain("srcdoc");
    expect(out).not.toContain("alert(1)");
  });

  it("removes forms and style blocks", () => {
    const out = sanitizeShareHtml(
      '<form action="https://evil.example"><input name="pw"><button>go</button></form><style>body{display:none}</style><p>kept</p>',
    );
    expect(out).not.toContain("<form");
    expect(out).not.toContain("<input");
    expect(out).not.toContain("<style");
    expect(out).toContain("<p>kept</p>");
  });

  it("forces rel=noopener noreferrer and target=_blank on http(s) links", () => {
    const out = sanitizeShareHtml('<a href="https://example.com" rel="opener">x</a>');
    const el = parse(out).querySelector("a");
    expect(el?.getAttribute("href")).toBe("https://example.com");
    expect(el?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(el?.getAttribute("target")).toBe("_blank");
  });
});

describe("sanitizeShareHtml — normal BlockNote markup survives", () => {
  it("keeps headings, lists, links, code and BlockNote's data-* attributes from a real export", async () => {
    const editor = ServerBlockNoteEditor.create({ schema: createServerSchema() as any });
    const blocks = [
      { type: "heading", props: { level: 2 }, content: "Plan" },
      { type: "bulletListItem", content: "first item" },
      { type: "numberedListItem", content: "second item" },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "see ", styles: {} },
          { type: "link", href: "https://kompast.example.com/docs", content: [{ type: "text", text: "docs", styles: {} }] },
        ],
      },
      { type: "codeBlock", props: { language: "typescript" }, content: "const x = 1;" },
    ];
    const ydoc = editor.blocksToYDoc(blocks as any, "document-store");
    const raw = await editor.blocksToFullHTML(editor.yDocToBlocks(ydoc, "document-store"));

    const out = sanitizeShareHtml(raw);
    const root = parse(out);

    expect(root.querySelector("h2")?.textContent).toBe("Plan");
    // BlockNote renders list items as divs keyed by data-content-type, not <li>.
    expect(root.querySelector('[data-content-type="heading"]')).not.toBeNull();
    expect(root.querySelector('[data-content-type="bulletListItem"]')?.textContent).toBe("first item");
    expect(root.querySelector('[data-content-type="numberedListItem"]')?.getAttribute("data-index")).toBe("1");
    expect(root.querySelector('[data-content-type="codeBlock"]')).not.toBeNull();
    expect(root.querySelector("code, pre")?.textContent).toContain("const x = 1;");

    const link = root.querySelector('a[href="https://kompast.example.com/docs"]');
    expect(link?.textContent).toBe("docs");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");

    // The rendered output has no active content at all.
    expect(out).not.toMatch(/<script|<iframe|<object|<embed|on[a-z]+=/i);
  });

  it("keeps tables and images with their attributes", () => {
    const html =
      '<table class="bn-table"><tbody><tr><th data-colspan="1">Name</th></tr>' +
      '<tr><td data-colspan="1">Ada</td></tr></tbody></table>' +
      '<img class="bn-visual-media" src="https://cdn.example.com/a.png" alt="diagram" width="320">';
    const root = parse(sanitizeShareHtml(html));
    expect(root.querySelector("table.bn-table th")?.textContent).toBe("Name");
    expect(root.querySelector("td")?.getAttribute("data-colspan")).toBe("1");
    const img = root.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://cdn.example.com/a.png");
    expect(img?.getAttribute("alt")).toBe("diagram");
    expect(img?.getAttribute("width")).toBe("320");
  });

  it("returns an empty string for empty input", () => {
    expect(sanitizeShareHtml("")).toBe("");
  });
});
