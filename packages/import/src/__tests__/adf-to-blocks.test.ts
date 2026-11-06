import { describe, expect, it } from "vitest";
import { adfToBlocks, nearestTextColor, type AdfBlockContext, type BlockNode } from "../jira/adf-to-blocks";

/**
 * ADF → BlockNote blocks, pure (no DB, no network). The ADF below follows the
 * shapes JIRA Cloud actually sends (doc/paragraph/text with marks, mention and
 * media attrs), scrubbed to a handful of nodes each.
 */

const BASE = "https://acme.atlassian.net";

const ctx: AdfBlockContext = {
  resolveUser: (accountId) => (accountId === "acc-ann" ? { userId: "user-ann", name: "Ann Lee" } : null),
  jiraBaseUrl: BASE,
  projectKeyJira: "ZTRD",
  kompast: { projectKey: "ztrd", teamId: "team-1" },
  attachments: [
    { id: "10001", filename: "diagram.png", content: `${BASE}/rest/api/3/attachment/content/10001`, mimeType: "image/png" },
    { id: "10002", filename: "spec.pdf", content: `${BASE}/rest/api/3/attachment/content/10002`, mimeType: "application/pdf" },
  ],
  issueKeyNumberFor: (key) => {
    const match = /^ZTRD-(\d+)$/.exec(key);
    return match ? Number(match[1]) : null;
  },
};

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const t = (text: string, ...marks: unknown[]) => (marks.length ? { type: "text", text, marks } : { type: "text", text });

/** The plain text of a block's own inline content (the shape the editor shows). */
function textOf(block: BlockNode): string {
  if (!Array.isArray(block.content)) return "";
  return block.content
    .map((n) => (n.type === "text" ? n.text : n.type === "link" ? n.content.map((c) => (c.type === "text" ? c.text : "")).join("") : ""))
    .join("");
}

describe("adfToBlocks", () => {
  it("converts paragraphs and marks: bold, italic, underline, strike, code, colour, subsup dropped, links kept", () => {
    const { blocks } = adfToBlocks(
      doc(
        p(
          t("bold", { type: "strong" }),
          t(" "),
          t("em", { type: "em" }),
          t(" "),
          t("under", { type: "underline" }),
          t(" "),
          t("struck", { type: "strike" }),
          t(" "),
          t("code", { type: "code" }),
          t(" "),
          t("red", { type: "textColor", attrs: { color: "#ff5630" } }),
          t(" "),
          t("2", { type: "subsup", attrs: { type: "sup" } }),
          t(" "),
          t("a link", { type: "link", attrs: { href: "https://example.com/x" } }),
        ),
      ),
      ctx,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "paragraph", props: {}, children: [] });
    const inline = blocks[0]!.content as unknown[];
    expect(inline).toContainEqual({ type: "text", text: "bold", styles: { bold: true } });
    expect(inline).toContainEqual({ type: "text", text: "em", styles: { italic: true } });
    expect(inline).toContainEqual({ type: "text", text: "under", styles: { underline: true } });
    expect(inline).toContainEqual({ type: "text", text: "struck", styles: { strike: true } });
    expect(inline).toContainEqual({ type: "text", text: "code", styles: { code: true } });
    expect(inline).toContainEqual({ type: "text", text: "red", styles: { textColor: "red" } });
    // subsup has no BlockNote equivalent: the text stays, unstyled.
    expect(inline).toContainEqual({ type: "text", text: "2", styles: {} });
    expect(inline).toContainEqual({ type: "link", href: "https://example.com/x", content: [{ type: "text", text: "a link", styles: {} }] });
  });

  it("maps headings (level 4-6 become 3), lists with nested children, task lists, blockquotes and code blocks", () => {
    const { blocks } = adfToBlocks(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [t("Two")] },
        { type: "heading", attrs: { level: 5 }, content: [t("Five")] },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [p(t("parent")), { type: "bulletList", content: [{ type: "listItem", content: [p(t("child"))] }] }],
            },
          ],
        },
        { type: "orderedList", attrs: { order: 1 }, content: [{ type: "listItem", content: [p(t("first"))] }] },
        {
          type: "taskList",
          attrs: { localId: "x" },
          content: [
            { type: "taskItem", attrs: { state: "DONE" }, content: [t("finished")] },
            { type: "taskItem", attrs: { state: "TODO" }, content: [t("open")] },
          ],
        },
        { type: "blockquote", content: [p(t("quoted"))] },
        { type: "codeBlock", attrs: { language: "ts" }, content: [t("const a = 1;")] },
      ),
      ctx,
    );

    expect(blocks.map((b) => b.type)).toEqual(["heading", "heading", "bulletListItem", "numberedListItem", "checkListItem", "checkListItem", "quote", "codeBlock"]);
    expect(blocks[0]!.props).toEqual({ level: 2 });
    expect(blocks[1]!.props).toEqual({ level: 3 });
    expect(blocks[2]!.children).toEqual([expect.objectContaining({ type: "bulletListItem" })]);
    expect(textOf(blocks[2]!.children[0]!)).toBe("child");
    expect(blocks[4]).toMatchObject({ props: { checked: true } });
    expect(blocks[5]).toMatchObject({ props: { checked: false } });
    expect(blocks[7]).toMatchObject({ props: { language: "ts" }, content: [{ type: "text", text: "const a = 1;", styles: {} }] });
  });

  it("turns a rule into a divider, and a table into a BlockNote table with a header row", () => {
    const { blocks } = adfToBlocks(
      doc(
        { type: "rule" },
        {
          type: "table",
          content: [
            { type: "tableRow", content: [{ type: "tableHeader", content: [p(t("Name"))] }, { type: "tableHeader", content: [p(t("Points"))] }] },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [p(t("Login"))] },
                { type: "tableCell", content: [p(t("3")), p(t("(est)"))] },
              ],
            },
          ],
        },
      ),
      ctx,
    );

    expect(blocks[0]).toMatchObject({ type: "divider" });
    expect(blocks[1]!.type).toBe("table");
    const table = blocks[1]!.content as { type: string; headerRows?: number; rows: { cells: unknown[][] }[] };
    expect(table.type).toBe("tableContent");
    expect(table.headerRows).toBe(1);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]!.cells[0]).toEqual([{ type: "text", text: "Name", styles: {} }]);
    // Two paragraphs in one cell become one run, separated by a line break.
    expect(table.rows[1]!.cells[1]).toEqual([
      { type: "text", text: "3", styles: {} },
      { type: "text", text: "\n", styles: {} },
      { type: "text", text: "(est)", styles: {} },
    ]);
  });

  it("writes a panel as a labelled quote, and an expand as its bold title followed by its content", () => {
    const { blocks } = adfToBlocks(
      doc(
        { type: "panel", attrs: { panelType: "warning" }, content: [p(t("Do not deploy on Friday."))] },
        { type: "expand", attrs: { title: "Details" }, content: [p(t("Hidden body."))] },
      ),
      ctx,
    );

    expect(blocks[0]!.type).toBe("quote");
    expect(blocks[0]!.content).toEqual([
      { type: "text", text: "Warning: ", styles: { bold: true } },
      { type: "text", text: "Do not deploy on Friday.", styles: {} },
    ]);
    expect(blocks[1]).toMatchObject({ type: "paragraph", content: [{ type: "text", text: "Details", styles: { bold: true } }] });
    expect(blocks[2]).toMatchObject({ type: "paragraph", content: [{ type: "text", text: "Hidden body.", styles: {} }] });
  });

  it("turns hardBreak into a newline, emoji into its text, a date into ISO, and a status lozenge into bold text", () => {
    const { blocks } = adfToBlocks(
      doc(
        p(t("line one"), { type: "hardBreak" }, t("line two")),
        p({ type: "emoji", attrs: { shortName: ":smile:", text: "😄" } }, t(" "), { type: "date", attrs: { timestamp: "1609459200000" } }),
        p({ type: "status", attrs: { text: "IN REVIEW", color: "yellow" } }),
      ),
      ctx,
    );

    expect(blocks[0]!.content).toEqual([
      { type: "text", text: "line one", styles: {} },
      { type: "text", text: "\n", styles: {} },
      { type: "text", text: "line two", styles: {} },
    ]);
    expect(blocks[1]!.content).toEqual([
      { type: "text", text: "😄", styles: {} },
      { type: "text", text: " ", styles: {} },
      { type: "text", text: "2021-01-01", styles: {} },
    ]);
    expect(blocks[2]!.content).toEqual([{ type: "text", text: "IN REVIEW", styles: { bold: true } }]);
  });

  it("turns a mention into a userMention when resolved, or plain @Name text when not", () => {
    const stats = adfToBlocks(
      doc(p({ type: "mention", attrs: { id: "acc-ann", text: "@Ann" } }, t(" and "), { type: "mention", attrs: { id: "acc-nobody", text: "@Nobody" } })),
      ctx,
    ).stats;
    const { blocks } = adfToBlocks(
      doc(p({ type: "mention", attrs: { id: "acc-ann", text: "@Ann" } }, t(" and "), { type: "mention", attrs: { id: "acc-nobody", text: "@Nobody" } })),
      ctx,
    );
    expect(blocks[0]!.content).toEqual([
      { type: "userMention", props: { userId: "user-ann", name: "Ann Lee" } },
      { type: "text", text: " and ", styles: {} },
      { type: "text", text: "@Nobody", styles: {} },
    ]);
    expect(stats.mentions).toBe(2);
  });

  it("turns a link to a key of the migrated project into an issueMention, and leaves another JIRA project's link as a link", () => {
    const { blocks, stats } = adfToBlocks(
      doc(
        p(
          { type: "text", text: "see ZTRD-42", marks: [{ type: "link", attrs: { href: `${BASE}/browse/ZTRD-42` } }] },
          t(" and "),
          { type: "text", text: "OTHER-7", marks: [{ type: "link", attrs: { href: `${BASE}/browse/OTHER-7` } }] },
          t(" "),
          { type: "inlineCard", attrs: { url: `${BASE}/browse/ZTRD-43` } },
        ),
        // A card on a line of its own is block-level in ADF's terms: it must not be dropped.
        { type: "blockCard", attrs: { url: `${BASE}/browse/ZTRD-44` } },
      ),
      ctx,
    );

    expect(blocks[0]!.content).toEqual([
      { type: "issueMention", props: { issueId: "", projectKey: "ztrd", keySeq: "42", title: "", teamId: "team-1" } },
      { type: "text", text: " and ", styles: {} },
      { type: "link", href: `${BASE}/browse/OTHER-7`, content: [{ type: "text", text: "OTHER-7", styles: {} }] },
      { type: "text", text: " ", styles: {} },
      { type: "issueMention", props: { issueId: "", projectKey: "ztrd", keySeq: "43", title: "", teamId: "team-1" } },
    ]);
    expect(blocks[1]).toMatchObject({ type: "paragraph", content: [{ type: "issueMention", props: { keySeq: "44" } }] });
    expect(stats.issueMentions).toBe(3);
  });

  it("matches media to this issue's attachments by filename: an image block for an image, a file block otherwise", () => {
    const { blocks, stats } = adfToBlocks(
      doc(
        { type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { type: "file", id: "m-1", alt: "diagram.png" } }] },
        { type: "mediaGroup", content: [{ type: "media", attrs: { type: "file", id: "m-2", alt: "spec.pdf" } }] },
      ),
      ctx,
    );

    expect(blocks[0]).toMatchObject({ type: "image", props: { url: `${BASE}/rest/api/3/attachment/content/10001`, name: "diagram.png", caption: "" } });
    expect(blocks[1]).toMatchObject({ type: "file", props: { url: `${BASE}/rest/api/3/attachment/content/10002`, name: "spec.pdf", caption: "" } });
    expect(stats.media).toBe(2);
  });

  it("writes unmatched media as an italic note naming the file, so nothing is lost silently", () => {
    const { blocks } = adfToBlocks(doc({ type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "m-9", alt: "gone.png" } }] }), ctx);
    expect(blocks).toEqual([
      { type: "paragraph", props: {}, content: [{ type: "text", text: "Attachment not found in JIRA: gone.png", styles: { italic: true } }], children: [] },
    ]);
  });

  it("keeps an unknown node's plain text as a paragraph, and counts its type", () => {
    const { blocks, stats } = adfToBlocks(
      doc(
        p(t("known")),
        { type: "decisionList", content: [{ type: "decisionItem", content: [p(t("We agreed on the plan."))] }] },
        { type: "mysteryInline", content: [t("odd inline")] },
      ),
      ctx,
    );
    expect(blocks.map((b) => textOf(b))).toEqual(["known", "We agreed on the plan.", "odd inline"]);
    expect(stats.unknownNodes).toEqual({ decisionList: 1, mysteryInline: 1 });
  });

  it("reads a plain string body as one paragraph per line, and never throws on odd input", () => {
    const fromString = adfToBlocks("first line\n\nsecond line", ctx);
    expect(fromString.blocks.map((b) => textOf(b))).toEqual(["first line", "second line"]);

    for (const odd of [null, undefined, 42, true, { type: "doc", content: "not-an-array" }, { foo: "bar" }, []]) {
      expect(() => adfToBlocks(odd, ctx)).not.toThrow();
    }
    expect(adfToBlocks(null, ctx).blocks).toEqual([]);
  });

  it("maps text colours to the nearest BlockNote palette name, and drops a value that isn't a colour", () => {
    expect(nearestTextColor("#ff5630")).toBe("red");
    expect(nearestTextColor("#00875a")).toBe("green");
    expect(nearestTextColor("#0052cc")).toBe("blue");
    expect(nearestTextColor("#ffffff")).toBe("gray");
    expect(nearestTextColor("not-a-colour")).toBeNull();
  });

  it("resolves a media node by attrs.__attachmentId before its name, even when the name is only a media id", () => {
    const { blocks, stats } = adfToBlocks(
      doc({
        type: "mediaSingle",
        content: [{ type: "media", attrs: { type: "file", id: "72de940d-0000-4000-8000-000000000000", __attachmentId: "10002" } }],
      }),
      ctx,
    );
    expect(blocks[0]).toMatchObject({ type: "file", props: { url: `${BASE}/rest/api/3/attachment/content/10002`, name: "spec.pdf" } });
    expect(stats).toMatchObject({ media: 1, mediaMatched: 1, mediaUnmatched: 0 });
  });

  it("falls back to the filename when __attachmentId names no attachment of this issue", () => {
    const { blocks, stats } = adfToBlocks(
      doc({ type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "m-5", alt: "diagram.png", __attachmentId: "99999" } }] }),
      ctx,
    );
    expect(blocks[0]).toMatchObject({ type: "image", props: { url: `${BASE}/rest/api/3/attachment/content/10001`, name: "diagram.png" } });
    expect(stats.mediaMatched).toBe(1);
  });

  it("counts file media that neither the id nor the name matches as unmatched", () => {
    const { blocks, stats } = adfToBlocks(
      doc({ type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "72de940d-0000-4000-8000-000000000000" } }] }),
      ctx,
    );
    expect(blocks[0]).toMatchObject({ type: "paragraph", content: [{ type: "text", text: "Attachment not found in JIRA: 72de940d-0000-4000-8000-000000000000" }] });
    expect(stats).toMatchObject({ media: 1, mediaMatched: 0, mediaUnmatched: 1 });
  });

  it("turns external media into an image block with its URL directly, and inline external media into a link", () => {
    const url = "https://img.example.com/diagram.png";
    const { blocks, stats } = adfToBlocks(
      doc(
        { type: "mediaSingle", content: [{ type: "media", attrs: { type: "external", url } }] },
        p({ type: "mediaInline", attrs: { type: "external", url } }),
      ),
      ctx,
    );
    expect(blocks[0]).toEqual({ type: "image", props: { url, name: url, caption: "" }, children: [] });
    expect(blocks[1]).toMatchObject({ type: "paragraph", content: [{ type: "link", href: url }] });
    expect(stats).toMatchObject({ media: 2, mediaMatched: 2, mediaUnmatched: 0 });
  });
});
