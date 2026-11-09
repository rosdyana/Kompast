import { describe, expect, it } from "vitest";
import { blocksToYDocState } from "@kompast/editor";
import {
  databaseTable,
  notionBlocksToBlockNote,
  type BlockNode,
  type InlineNode,
  propertiesTable,
  propertyValueText,
  type NotionBlockWithChildren,
  type NotionConvertContext,
} from "../notion-api/blocks-to-blocknote";
import type { NotionPage, NotionPropertyValue, NotionRichText } from "../notion-api/types";

const KNOWN_PAGE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KNOWN_PAGE_NODASH = "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";
const UNKNOWN_PAGE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MAYA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const IMAGE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
/** The notion.so link an unimported Notion object becomes. */
const notionUrlOf = (id: string) => `https://www.notion.so/${id.replace(/-/g, "")}`;

const ctx: NotionConvertContext = {
  resolvePage: (id) => (id === KNOWN_PAGE ? { pageId: "kompast-page-1", title: "Onboarding", icon: "🚀" } : null),
  userName: (id, fallback) => (id === MAYA ? "Maya Kompast" : fallback || "Notion user"),
  assetUrl: (blockId) => (blockId === IMAGE_ID ? { url: "/api/page-assets/p/pic.png", name: "pic.png" } : null),
};

function t(content: string, extra: Partial<NotionRichText> = {}, annotations: Record<string, boolean | string> = {}): NotionRichText {
  return {
    type: "text",
    plain_text: content,
    href: null,
    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default", ...annotations },
    text: { content, link: null },
    ...extra,
  } as NotionRichText;
}

function block(type: string, id: string, value: Record<string, unknown>, children: NotionBlockWithChildren[] = []): NotionBlockWithChildren {
  return { object: "block", id, type, has_children: children.length > 0, [type]: value, children } as NotionBlockWithChildren;
}

/** A block's inline content, for tests that read the first node of a paragraph-like block. */
function inlineOf(b: BlockNode): InlineNode[] {
  return (b.content ?? []) as InlineNode[];
}

function convert(blocks: NotionBlockWithChildren[]) {
  return notionBlocksToBlockNote(blocks, ctx);
}

describe("Notion blocks to BlockNote blocks", () => {
  it("maps paragraphs, headings and list items, keeping nested children", () => {
    const { blocks, stats } = convert([
      block("paragraph", "p1", { rich_text: [t("Hello")] }),
      block("heading_2", "h1", { rich_text: [t("Toggle head")], is_toggleable: true }, [block("paragraph", "p2", { rich_text: [t("Inside")] })]),
      block("heading_3", "h2", { rich_text: [t("Plain head")], is_toggleable: false }),
      block("bulleted_list_item", "b1", { rich_text: [t("Parent")] }, [block("numbered_list_item", "n1", { rich_text: [t("Child")] })]),
    ]);
    expect(blocks[0]).toEqual({ type: "paragraph", props: {}, content: [{ type: "text", text: "Hello", styles: {} }], children: [] });
    expect(blocks[1]).toMatchObject({ type: "heading", props: { level: 2, isToggleable: true }, children: [{ type: "paragraph" }] });
    expect(blocks[2]).toMatchObject({ type: "heading", props: { level: 3 } });
    expect(blocks[2]!.props).not.toHaveProperty("isToggleable");
    expect(blocks[3]).toMatchObject({ type: "bulletListItem", children: [{ type: "numberedListItem" }] });
    expect(stats).toEqual({ unknownBlocks: 0, filesNotImported: 0 });
  });

  it("maps Notion's heading_4 to a level-4 heading, not an unknown block (seen in a real workspace)", () => {
    const { blocks, stats } = convert([block("heading_4", "h4", { rich_text: [t("Fourth")] })]);
    expect(blocks[0]).toMatchObject({ type: "heading", props: { level: 4 }, content: [{ type: "text", text: "Fourth" }] });
    expect(stats.unknownBlocks).toBe(0);
    // Level 4 must be valid in the stored schema too.
    expect(() => blocksToYDocState(blocks)).not.toThrow();
  });

  it("maps rich text styles and links", () => {
    const { blocks } = convert([
      block("paragraph", "p", {
        rich_text: [
          t("b", {}, { bold: true }),
          t("i", {}, { italic: true }),
          t("s", {}, { strikethrough: true }),
          t("u", {}, { underline: true }),
          t("c", {}, { code: true }),
          t("site", { href: "https://example.com/x", text: { content: "site", link: { url: "https://example.com/x" } } }),
        ],
      }),
    ]);
    expect(blocks[0]!.content).toEqual([
      { type: "text", text: "b", styles: { bold: true } },
      { type: "text", text: "i", styles: { italic: true } },
      { type: "text", text: "s", styles: { strike: true } },
      { type: "text", text: "u", styles: { underline: true } },
      { type: "text", text: "c", styles: { code: true } },
      { type: "link", href: "https://example.com/x", content: [{ type: "text", text: "site", styles: {} }] },
    ]);
  });

  it("turns a page mention into a Kompast mention when the page was imported, and a notion.so link otherwise", () => {
    const { blocks } = convert([
      block("paragraph", "p", {
        rich_text: [
          { type: "mention", plain_text: "Onboarding", mention: { type: "page", page: { id: KNOWN_PAGE_NODASH } }, annotations: {} },
          t(" and "),
          { type: "mention", plain_text: "Never imported", mention: { type: "page", page: { id: UNKNOWN_PAGE } }, annotations: {} },
        ] as NotionRichText[],
      }),
    ]);
    expect(blocks[0]!.content).toEqual([
      { type: "mention", props: { pageId: "kompast-page-1", title: "Onboarding", icon: "🚀" } },
      { type: "text", text: " and ", styles: {} },
      { type: "link", href: notionUrlOf(UNKNOWN_PAGE), content: [{ type: "text", text: "Never imported", styles: {} }] },
    ]);
  });

  it("links an unimported database mention to Notion, and mentions an imported one", () => {
    const { blocks } = convert([
      block("paragraph", "p", {
        rich_text: [
          { type: "mention", plain_text: "Tasks", mention: { type: "database", database: { id: UNKNOWN_PAGE } }, annotations: { bold: true } },
          { type: "mention", plain_text: "Onboarding", mention: { type: "database", database: { id: KNOWN_PAGE } }, annotations: {} },
        ] as NotionRichText[],
      }),
    ]);
    expect(blocks[0]!.content).toEqual([
      { type: "link", href: notionUrlOf(UNKNOWN_PAGE), content: [{ type: "text", text: "Tasks", styles: { bold: true } }] },
      { type: "mention", props: { pageId: "kompast-page-1", title: "Onboarding", icon: "🚀" } },
    ]);
  });

  it("puts a sub-page at its place in the body as a mention when it was imported, and as a notion.so link with its title when not", () => {
    const seen: string[] = [];
    const spy: NotionConvertContext = {
      ...ctx,
      resolvePage: (id) => {
        seen.push(id);
        return ctx.resolvePage(id);
      },
    };
    const { blocks, stats } = notionBlocksToBlockNote(
      [
        block("heading_2", "h", { rich_text: [t("Team")] }),
        block("child_page", KNOWN_PAGE, { title: "Onboarding" }),
        block("child_page", UNKNOWN_PAGE, { title: "" }),
        block("child_database", IMAGE_ID, { title: "Projects" }),
        block("child_database", MAYA, { title: "" }),
      ],
      spy,
    );
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "paragraph", "paragraph", "paragraph"]);
    expect(blocks[1]!.content).toEqual([{ type: "mention", props: { pageId: "kompast-page-1", title: "Onboarding", icon: "🚀" } }]);
    expect(blocks[2]!.content).toEqual([{ type: "link", href: notionUrlOf(UNKNOWN_PAGE), content: [{ type: "text", text: "Untitled", styles: {} }] }]);
    expect(blocks[3]!.content).toEqual([{ type: "link", href: notionUrlOf(IMAGE_ID), content: [{ type: "text", text: "Projects", styles: {} }] }]);
    expect(blocks[4]!.content).toEqual([{ type: "link", href: notionUrlOf(MAYA), content: [{ type: "text", text: "Untitled database", styles: {} }] }]);
    // Resolved through the context, so the caller can record the mention (the backlink).
    expect(seen).toEqual([KNOWN_PAGE, UNKNOWN_PAGE, IMAGE_ID, MAYA]);
    expect(stats).toEqual({ unknownBlocks: 0, filesNotImported: 0 });
  });

  it("turns a link to an imported Notion page into a mention, and any other notion.so link into a link", () => {
    const { blocks } = convert([
      block("paragraph", "p", {
        rich_text: [
          t("open", { href: `https://www.notion.so/Onboarding-${KNOWN_PAGE_NODASH}` }),
          t("elsewhere", { href: "https://www.notion.so/Missing-" + UNKNOWN_PAGE.replace(/-/g, "") }),
        ],
      }),
    ]);
    expect(blocks[0]!.content).toEqual([
      { type: "mention", props: { pageId: "kompast-page-1", title: "Onboarding", icon: "🚀" } },
      { type: "link", href: `https://www.notion.so/Missing-${UNKNOWN_PAGE.replace(/-/g, "")}`, content: [{ type: "text", text: "elsewhere", styles: {} }] },
    ]);
  });

  it("writes a user mention as @name (the matched Kompast name when known), and equations as $...$", () => {
    const { blocks } = convert([
      block("paragraph", "p", {
        rich_text: [
          { type: "mention", plain_text: "@Notion Maya", mention: { type: "user", user: { id: MAYA, name: "Notion Maya" } }, annotations: {} },
          t(" "),
          { type: "mention", plain_text: "@Sam", mention: { type: "user", user: { id: "other", name: "Sam" } }, annotations: {} },
          t(" "),
          { type: "equation", plain_text: "x^2", equation: { expression: "x^2" }, annotations: {} },
          t(" "),
          { type: "mention", plain_text: "2025-01-01", mention: { type: "date", date: { start: "2025-01-01" } }, annotations: {} },
        ] as NotionRichText[],
      }),
    ]);
    expect(blocks[0]!.content).toEqual([
      { type: "text", text: "@Maya Kompast", styles: {} },
      { type: "text", text: " ", styles: {} },
      { type: "text", text: "@Sam", styles: {} },
      { type: "text", text: " ", styles: {} },
      { type: "text", text: "$x^2$", styles: {} },
      { type: "text", text: " ", styles: {} },
      { type: "text", text: "2025-01-01", styles: {} },
    ]);
  });

  it("maps to-dos, toggles, quotes, callouts, code, equations and dividers", () => {
    const { blocks } = convert([
      block("to_do", "t1", { rich_text: [t("done")], checked: true }),
      block("toggle", "t2", { rich_text: [t("more")] }, [block("paragraph", "t3", { rich_text: [t("hidden")] })]),
      block("quote", "q1", { rich_text: [t("wise")] }),
      block("callout", "c1", { rich_text: [t("Tip")], icon: { type: "emoji", emoji: "💡" } }),
      block("code", "k1", { rich_text: [t("const x = 1;")], language: "javascript" }),
      block("code", "k2", { rich_text: [t("plain")], language: "Plain Text" }),
      block("equation", "e1", { expression: "E = mc^2" }),
      block("divider", "d1", {}),
    ]);
    expect(blocks[0]).toMatchObject({ type: "checkListItem", props: { checked: true } });
    expect(blocks[1]).toMatchObject({ type: "toggleListItem", children: [{ type: "paragraph" }] });
    expect(blocks[2]).toMatchObject({ type: "quote", content: [{ type: "text", text: "wise" }] });
    expect(blocks[3]).toMatchObject({ type: "quote", content: [{ type: "text", text: "💡 " }, { type: "text", text: "Tip" }] });
    expect(blocks[4]).toMatchObject({ type: "codeBlock", props: { language: "javascript" }, content: [{ type: "text", text: "const x = 1;", styles: {} }] });
    expect(blocks[5]).toMatchObject({ type: "codeBlock", props: { language: "text" } });
    expect(blocks[6]).toMatchObject({ type: "codeBlock", props: { language: "latex" }, content: [{ type: "text", text: "E = mc^2" }] });
    expect(blocks[7]).toEqual({ type: "divider", props: {}, children: [] });
  });

  it("maps a table to a table block with a header row when Notion marks one, and does not emit the rows as children", () => {
    const row = (...cells: string[]) => block("table_row", `r-${cells.join("")}`, { cells: cells.map((c) => [t(c)]) });
    const { blocks } = convert([block("table", "tb", { table_width: 2, has_column_header: true }, [row("Name", "Qty"), row("Pen", "3")])]);
    expect(blocks).toEqual([
      {
        type: "table",
        props: { textColor: "default" },
        content: {
          type: "tableContent",
          columnWidths: [],
          headerRows: 1,
          rows: [
            { cells: [[{ type: "text", text: "Name", styles: {} }], [{ type: "text", text: "Qty", styles: {} }]] },
            { cells: [[{ type: "text", text: "Pen", styles: {} }], [{ type: "text", text: "3", styles: {} }]] },
          ],
        },
        children: [],
      },
    ]);
  });

  it("copies a Notion-hosted image when it was stored, and leaves a 'File not imported' paragraph when it wasn't", () => {
    const { blocks, stats } = convert([
      block("image", IMAGE_ID, { type: "file", file: { url: "https://s3.example.com/pic.png?sig=1" }, caption: [t("A cap")] }),
      block("file", "f2", { type: "file", file: { url: "https://s3.example.com/report.pdf?sig=2" }, name: "report.pdf" }),
    ]);
    expect(blocks[0]).toEqual({ type: "image", props: { url: "/api/page-assets/p/pic.png", name: "pic.png", caption: "A cap" }, children: [] });
    expect(blocks[1]).toEqual({ type: "paragraph", props: {}, content: [{ type: "text", text: "File not imported: report.pdf", styles: {} }], children: [] });
    expect(stats.filesNotImported).toBe(1);
  });

  it("keeps an external image as a link, and maps pdf, video and audio to their block types", () => {
    const { blocks } = convert([
      block("image", "ext", { type: "external", external: { url: "https://cdn.example.com/a.png" }, caption: [] }),
      block("pdf", "pdf1", { type: "external", external: { url: "https://cdn.example.com/b.pdf" }, caption: [] }),
      block("video", "v1", { type: "external", external: { url: "https://cdn.example.com/c.mp4" }, caption: [] }),
      block("audio", "a1", { type: "external", external: { url: "https://cdn.example.com/d.mp3" }, caption: [] }),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(["image", "file", "video", "audio"]);
    expect(blocks[0]!.props).toMatchObject({ url: "https://cdn.example.com/a.png", name: "a.png" });
  });

  it("turns bookmarks, embeds and link previews into links, and link_to_page into a mention or a notion.so link", () => {
    const { blocks } = convert([
      block("bookmark", "bm", { url: "https://example.com/a", caption: [t("Read this")] }),
      block("embed", "em", { url: "https://example.com/e" }),
      block("link_preview", "lp", { url: "https://example.com/l" }),
      block("link_to_page", "lk1", { type: "page_id", page_id: KNOWN_PAGE }),
      block("link_to_page", "lk2", { type: "page_id", page_id: UNKNOWN_PAGE }),
    ]);
    expect(blocks[0]!.content).toEqual([{ type: "link", href: "https://example.com/a", content: [{ type: "text", text: "Read this", styles: {} }] }]);
    expect(blocks[1]!.content).toEqual([{ type: "link", href: "https://example.com/e", content: [{ type: "text", text: "https://example.com/e", styles: {} }] }]);
    expect(inlineOf(blocks[2]!)[0]).toMatchObject({ type: "link", href: "https://example.com/l" });
    expect(blocks[3]!.content).toEqual([{ type: "mention", props: { pageId: "kompast-page-1", title: "Onboarding", icon: "🚀" } }]);
    expect(inlineOf(blocks[4]!)[0]).toMatchObject({ type: "link", href: `https://www.notion.so/${UNKNOWN_PAGE.replace(/-/g, "")}` });
  });

  it("flattens columns and synced blocks, drops table of contents, and counts unknown blocks", () => {
    const { blocks, stats } = convert([
      block("column_list", "cl", {}, [
        block("column", "c1", {}, [block("paragraph", "l", { rich_text: [t("Left")] })]),
        block("column", "c2", {}, [block("paragraph", "r", { rich_text: [t("Right")] })]),
      ]),
      block("synced_block", "sb", { synced_from: null }, [block("paragraph", "s", { rich_text: [t("Synced")] })]),
      block("table_of_contents", "toc", {}),
      block("meeting_notes", "mn", { title: [t("Standup")] }, [block("paragraph", "mnp", { rich_text: [t("Notes")] })]),
      block("unsupported", "u", {}),
    ]);
    expect(blocks.map((b) => (inlineOf(b)[0] as { text?: string } | undefined)?.text ?? b.type)).toEqual(["Left", "Right", "Synced", "Standup", "Notes"]);
    expect(stats.unknownBlocks).toBe(2);
  });
});

describe("properties and database tables", () => {
  const props: Record<string, NotionPropertyValue> = {
    Name: { type: "title", title: [t("Launch")] as unknown as NotionRichText[] },
    Notes: { type: "rich_text", rich_text: [t("bold note", {}, { bold: true })] },
    Count: { type: "number", number: 42 },
    Stage: { type: "select", select: { name: "Doing" } },
    Tags: { type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] },
    Health: { type: "status", status: { name: "On track" } },
    Window: { type: "date", date: { start: "2025-02-01", end: "2025-02-10" } },
    Owner: { type: "people", people: [{ id: MAYA, name: "Notion Maya" }] },
    Shipped: { type: "checkbox", checkbox: true },
    Link: { type: "url", url: "https://example.com" },
    Mail: { type: "email", email: "a@example.com" },
    Phone: { type: "phone_number", phone_number: "+62 811" },
    Calc: { type: "formula", formula: { type: "number", number: 7 } },
    Related: { type: "relation", relation: [{ id: KNOWN_PAGE }, { id: UNKNOWN_PAGE }] },
    Roll: { type: "rollup", rollup: { type: "number", number: 3 } },
    Files: { type: "files", files: [{ name: "spec.pdf" }, { name: "plan.md" }] },
    Created: { type: "created_time", created_time: "2025-01-01T00:00:00.000Z" },
    By: { type: "created_by", created_by: { id: MAYA, name: "Notion Maya" } },
    Ticket: { type: "unique_id", unique_id: { prefix: "KMP", number: 12 } },
    Check: { type: "verification", verification: { state: "verified" } },
    Unknown: { type: "something_new", something_new: {} },
  };

  it("reads each property type into cell text, relations as mentions", () => {
    const cell = (name: string) => propertyValueText(props[name], ctx);
    expect(cell("Name")).toEqual([{ type: "text", text: "Launch", styles: {} }]);
    expect(cell("Notes")).toEqual([{ type: "text", text: "bold note", styles: { bold: true } }]);
    expect(cell("Count")).toEqual([{ type: "text", text: "42", styles: {} }]);
    expect(cell("Stage")).toEqual([{ type: "text", text: "Doing", styles: {} }]);
    // Each multi_select value is its own run; the separator is unstyled.
    expect(cell("Tags")).toEqual([
      { type: "text", text: "a", styles: {} },
      { type: "text", text: ", ", styles: {} },
      { type: "text", text: "b", styles: {} },
    ]);
    expect(cell("Health")).toEqual([{ type: "text", text: "On track", styles: {} }]);
    expect(cell("Window")).toEqual([{ type: "text", text: "2025-02-01 → 2025-02-10", styles: {} }]);
    expect(cell("Owner")).toEqual([{ type: "text", text: "Maya Kompast", styles: {} }]);
    expect(cell("Shipped")).toEqual([{ type: "text", text: "✓", styles: {} }]);
    expect(cell("Link")).toEqual([{ type: "text", text: "https://example.com", styles: {} }]);
    expect(cell("Calc")).toEqual([{ type: "text", text: "7", styles: {} }]);
    expect(cell("Related")).toEqual([
      { type: "mention", props: { pageId: "kompast-page-1", title: "Onboarding", icon: "🚀" } },
      { type: "text", text: ", ", styles: {} },
      { type: "text", text: UNKNOWN_PAGE, styles: {} },
    ]);
    expect(cell("Roll")).toEqual([{ type: "text", text: "3", styles: {} }]);
    expect(cell("Files")).toEqual([{ type: "text", text: "spec.pdf, plan.md", styles: {} }]);
    expect(cell("Created")).toEqual([{ type: "text", text: "2025-01-01T00:00:00.000Z", styles: {} }]);
    expect(cell("By")).toEqual([{ type: "text", text: "Maya Kompast", styles: {} }]);
    expect(cell("Ticket")).toEqual([{ type: "text", text: "KMP-12", styles: {} }]);
    expect(cell("Check")).toEqual([{ type: "text", text: "verified", styles: {} }]);
    expect(cell("Unknown")).toEqual([]);
  });

  it("builds a two-column Property | Value table for a row's properties, and nothing for an empty row", () => {
    const table = propertiesTable({ Stage: props.Stage!, Count: props.Count! }, ctx);
    expect(table).toMatchObject({
      type: "table",
      content: {
        headerRows: 1,
        rows: [
          { cells: [[{ type: "text", text: "Property", styles: { bold: true } }], [{ type: "text", text: "Value", styles: { bold: true } }]] },
          { cells: [[{ type: "text", text: "Stage", styles: {} }], [{ type: "text", text: "Doing", styles: {} }]] },
          { cells: [[{ type: "text", text: "Count", styles: {} }], [{ type: "text", text: "42", styles: {} }]] },
        ],
      },
    });
    expect(propertiesTable({}, ctx)).toBeNull();
  });

  function row(id: string, title: string, extra: Record<string, NotionPropertyValue>): NotionPage {
    return { object: "page", id, parent: { type: "data_source_id", data_source_id: "ds" }, properties: { Name: { type: "title", title: [t(title)] as unknown as NotionRichText[] }, ...extra } } as unknown as NotionPage;
  }

  it("builds a database table: title column first, a mention to each row's page, then the schema's columns", () => {
    const rows = [
      row(KNOWN_PAGE, "Onboarding", { Stage: { type: "select", select: { name: "Done" } } }),
      row(UNKNOWN_PAGE, "Not imported", { Stage: { type: "select", select: { name: "Doing" } } }),
    ];
    const table = databaseTable(
      [
        { name: "Stage", type: "select" },
        { name: "Name", type: "title" },
      ],
      rows,
      ctx,
    );
    const content = table.content as { headerRows: number; rows: { cells: unknown[][] }[] };
    expect(content.headerRows).toBe(1);
    expect(content.rows[0]!.cells).toEqual([[{ type: "text", text: "Name", styles: { bold: true } }], [{ type: "text", text: "Stage", styles: { bold: true } }]]);
    expect(content.rows[1]!.cells).toEqual([
      [{ type: "mention", props: { pageId: "kompast-page-1", title: "Onboarding", icon: "🚀" } }],
      [{ type: "text", text: "Done", styles: {} }],
    ]);
    expect(content.rows[2]!.cells[0]).toEqual([{ type: "text", text: "Not imported", styles: {} }]);
  });

  it("derives the columns from the rows when there is no schema", () => {
    const table = databaseTable([], [row(UNKNOWN_PAGE, "Solo", { Stage: { type: "select", select: { name: "Todo" } } })], ctx);
    const content = table.content as { rows: { cells: unknown[][] }[] };
    expect(content.rows[0]!.cells).toHaveLength(2);
    expect(content.rows[1]!.cells[1]).toEqual([{ type: "text", text: "Todo", styles: {} }]);
  });
});

describe("output is accepted by the editor's schema", () => {
  it("encodes converted pages, tables and property blocks to Yjs state without error", () => {
    const converted = convert([
      block("heading_1", "h", { rich_text: [t("Title")] }),
      block("paragraph", "p", {
        rich_text: [
          { type: "mention", plain_text: "Onboarding", mention: { type: "page", page: { id: KNOWN_PAGE } }, annotations: {} },
          t(" bold", {}, { bold: true }),
        ] as NotionRichText[],
      }),
      block("table", "tb", { table_width: 1, has_column_header: true }, [block("table_row", "tr", { cells: [[t("Cell")]] })]),
      block("image", IMAGE_ID, { type: "file", file: { url: "https://s3.example.com/pic.png" } }),
      block("toggle", "tg", { rich_text: [t("Toggle")] }, [block("paragraph", "tp", { rich_text: [t("Hidden")] })]),
      block("callout", "co", { rich_text: [t("Heads up")], icon: { type: "emoji", emoji: "⚠️" } }),
      block("divider", "dv", {}),
      block("code", "cd", { rich_text: [t("x")], language: "typescript" }),
    ]);
    const props = propertiesTable({ Stage: { type: "select", select: { name: "Doing" } } }, ctx);
    const state = blocksToYDocState([...(props ? [props] : []), ...converted.blocks]);
    expect(state).toBeInstanceOf(Uint8Array);
    expect(state.byteLength).toBeGreaterThan(0);
  });

  it("encodes colored text, colored blocks and a colored callout without error", () => {
    const converted = convert([
      block("paragraph", "pc", { rich_text: [t("Warm", {}, { color: "red" }), t(" cool", {}, { color: "blue_background" })], color: "purple" }),
      block("heading_2", "hc", { rich_text: [t("Head")], is_toggleable: false, color: "pink_background" }),
      block("callout", "cc", { rich_text: [t("Note")], icon: { type: "emoji", emoji: "📌" }, color: "gray_background" }),
    ]);
    const state = blocksToYDocState(converted.blocks);
    expect(state.byteLength).toBeGreaterThan(0);
    // The color values are stored in the Yjs state (BlockNote writes them as UTF-8 strings).
    const text = Buffer.from(state).toString("utf8");
    for (const name of ["purple", "red", "blue", "pink", "gray"]) expect(text).toContain(name);
  });
});

describe("Notion colors", () => {
  it("maps an inline text color to textColor and a *_background color to backgroundColor, and leaves default out", () => {
    const { blocks } = convert([
      block("paragraph", "p", {
        rich_text: [
          t("red text", {}, { color: "red" }),
          t("gray bg", {}, { color: "gray_background" }),
          t("plain", {}, { color: "default" }),
          t("bold blue", {}, { bold: true, color: "blue" }),
          t("not a BlockNote color", {}, { color: "mauve" }),
          t("site", { href: "https://example.com/c", text: { content: "site", link: { url: "https://example.com/c" } } }, { color: "green" }),
        ],
      }),
    ]);
    expect(blocks[0]!.content).toEqual([
      { type: "text", text: "red text", styles: { textColor: "red" } },
      { type: "text", text: "gray bg", styles: { backgroundColor: "gray" } },
      { type: "text", text: "plain", styles: {} },
      { type: "text", text: "bold blue", styles: { bold: true, textColor: "blue" } },
      { type: "text", text: "not a BlockNote color", styles: {} },
      { type: "link", href: "https://example.com/c", content: [{ type: "text", text: "site", styles: { textColor: "green" } }] },
    ]);
  });

  it("maps a block's color to textColor or backgroundColor on the block types that have those props, and omits default", () => {
    const { blocks } = convert([
      block("paragraph", "p", { rich_text: [t("a")], color: "purple" }),
      block("heading_1", "h", { rich_text: [t("b")], is_toggleable: false, color: "pink_background" }),
      block("bulleted_list_item", "bl", { rich_text: [t("c")], color: "orange" }),
      block("numbered_list_item", "nl", { rich_text: [t("d")], color: "default" }),
      block("to_do", "td", { rich_text: [t("e")], checked: false, color: "green_background" }),
      block("toggle", "tg", { rich_text: [t("f")], color: "brown" }),
      block("quote", "q", { rich_text: [t("g")], color: "yellow_background" }),
    ]);
    expect(blocks.map((b) => b.props)).toEqual([
      { textColor: "purple" },
      { level: 1, backgroundColor: "pink" },
      { textColor: "orange" },
      {},
      { checked: false, backgroundColor: "green" },
      { textColor: "brown" },
      { backgroundColor: "yellow" },
    ]);
  });

  it("carries a callout's color onto the quote it becomes, and keeps the emoji lead", () => {
    const { blocks } = convert([
      block("callout", "c1", { rich_text: [t("Tip")], icon: { type: "emoji", emoji: "💡" }, color: "gray_background" }),
      block("callout", "c2", { rich_text: [t("Plain")], icon: { type: "emoji", emoji: "📌" }, color: "default" }),
    ]);
    expect(blocks[0]).toMatchObject({ type: "quote", props: { backgroundColor: "gray" }, content: [{ type: "text", text: "💡 " }, { type: "text", text: "Tip" }] });
    expect(blocks[1]!.props).toEqual({});
  });
});

describe("select, status and multi_select colors", () => {
  const option = (name: string, color?: string) => (color === undefined ? { name } : { name, color });

  it("renders an option as a text run whose backgroundColor is the option's color, and default as unstyled", () => {
    expect(propertyValueText({ type: "select", select: option("Done", "green") }, ctx)).toEqual([{ type: "text", text: "Done", styles: { backgroundColor: "green" } }]);
    expect(propertyValueText({ type: "status", status: option("On track", "blue") }, ctx)).toEqual([
      { type: "text", text: "On track", styles: { backgroundColor: "blue" } },
    ]);
    expect(propertyValueText({ type: "select", select: option("Plain", "default") }, ctx)).toEqual([{ type: "text", text: "Plain", styles: {} }]);
    expect(propertyValueText({ type: "select", select: null }, ctx)).toEqual([]);
  });

  it("colors each multi_select value on its own run, joined by unstyled ', '; a color BlockNote lacks stays unstyled", () => {
    const cell = propertyValueText(
      { type: "multi_select", multi_select: [option("Web", "red"), option("Mobile", "mauve"), option("Ops")] },
      ctx,
    );
    expect(cell).toEqual([
      { type: "text", text: "Web", styles: { backgroundColor: "red" } },
      { type: "text", text: ", ", styles: {} },
      { type: "text", text: "Mobile", styles: {} },
      { type: "text", text: ", ", styles: {} },
      { type: "text", text: "Ops", styles: {} },
    ]);
  });

  it("uses the colored runs in database table cells and in a row's properties table", () => {
    const rowPage = {
      object: "page",
      id: KNOWN_PAGE,
      parent: { type: "data_source_id", data_source_id: "ds" },
      properties: { Name: { type: "title", title: [t("Onboarding")] as unknown as NotionRichText[] }, Priority: { type: "select", select: option("High", "red") } },
    } as unknown as NotionPage;
    const table = databaseTable(
      [
        { name: "Name", type: "title" },
        { name: "Priority", type: "select" },
      ],
      [rowPage],
      ctx,
    );
    const content = table.content as { rows: { cells: unknown[][] }[] };
    expect(content.rows[1]!.cells[1]).toEqual([{ type: "text", text: "High", styles: { backgroundColor: "red" } }]);

    const props = propertiesTable({ Status: { type: "status", status: option("Done", "green") } }, ctx);
    const propsContent = props!.content as { rows: { cells: unknown[][] }[] };
    expect(propsContent.rows[1]!.cells[1]).toEqual([{ type: "text", text: "Done", styles: { backgroundColor: "green" } }]);
  });

  it("encodes colored table cells to Yjs state without error", () => {
    const table = databaseTable(
      [{ name: "Tags", type: "multi_select" }, { name: "Priority", type: "select" }],
      [
        {
          object: "page",
          id: KNOWN_PAGE,
          parent: { type: "data_source_id", data_source_id: "ds" },
          properties: {
            Name: { type: "title", title: [t("Onboarding")] as unknown as NotionRichText[] },
            Tags: { type: "multi_select", multi_select: [option("Web", "red"), option("Ops")] },
            Priority: { type: "select", select: option("High", "orange") },
          },
        } as unknown as NotionPage,
      ],
      ctx,
    );
    expect(blocksToYDocState([table]).byteLength).toBeGreaterThan(0);
  });
});

describe("inline databases", () => {
  const INLINE_DB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const OTHER_DB = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const schemaCols = [
    { name: "Name", type: "title" },
    { name: "Stage", type: "select" },
  ];
  const rowPage = (id: string, title: string, stage: { name: string; color?: string }) =>
    ({
      object: "page",
      id,
      parent: { type: "data_source_id", data_source_id: "ds" },
      properties: { Name: { type: "title", title: [t(title)] as unknown as NotionRichText[] }, Stage: { type: "select", select: stage } },
    }) as unknown as NotionPage;
  const rows = [rowPage(KNOWN_PAGE, "Onboarding", { name: "Done", color: "green" }), rowPage(UNKNOWN_PAGE, "Not imported", { name: "Doing" })];
  const inlineCtx: NotionConvertContext = {
    ...ctx,
    inlineDatabase: (id) => (id === INLINE_DB ? { properties: schemaCols, rows } : null),
  };

  it("emits the database's table at the block's position, after a link paragraph to the database page", () => {
    const { blocks } = notionBlocksToBlockNote(
      [
        block("paragraph", "before", { rich_text: [t("Before")] }),
        block("child_database", INLINE_DB, { title: "Projects" }),
        block("paragraph", "after", { rich_text: [t("After")] }),
      ],
      inlineCtx,
    );
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph", "table", "paragraph"]);
    expect(blocks[1]!.content).toEqual([{ type: "link", href: notionUrlOf(INLINE_DB), content: [{ type: "text", text: "Projects", styles: {} }] }]);
    const content = blocks[2]!.content as { headerRows: number; rows: { cells: InlineNode[][] }[] };
    expect(content.headerRows).toBe(1);
    expect(content.rows[0]!.cells).toEqual([[{ type: "text", text: "Name", styles: { bold: true } }], [{ type: "text", text: "Stage", styles: { bold: true } }]]);
    // First cells are mentions to the row pages; unimported rows fall back to their title.
    expect(content.rows[1]!.cells[0]).toEqual([{ type: "mention", props: { pageId: "kompast-page-1", title: "Onboarding", icon: "🚀" } }]);
    expect(content.rows[1]!.cells[1]).toEqual([{ type: "text", text: "Done", styles: { backgroundColor: "green" } }]);
    expect(content.rows[2]!.cells[0]).toEqual([{ type: "text", text: "Not imported", styles: {} }]);
    expect(blocks[3]!.content).toEqual([{ type: "text", text: "After", styles: {} }]);
  });

  it("keeps a link alone for a database that isn't inline, for one with no table to show, and for a child page", () => {
    const plain = notionBlocksToBlockNote([block("child_database", INLINE_DB, { title: "Projects" })], ctx).blocks;
    expect(plain.map((b) => b.type)).toEqual(["paragraph"]);
    const nullTable = notionBlocksToBlockNote([block("child_database", OTHER_DB, { title: "Big" })], inlineCtx).blocks;
    expect(nullTable.map((b) => b.type)).toEqual(["paragraph"]);
    const page = notionBlocksToBlockNote([block("child_page", INLINE_DB, { title: "Projects" })], inlineCtx).blocks;
    expect(page.map((b) => b.type)).toEqual(["paragraph"]);
  });

  it("resolves the inline database's id and its rows through the context, so the caller can record the backlinks", () => {
    const seen: string[] = [];
    const spy: NotionConvertContext = {
      ...inlineCtx,
      resolvePage: (id) => {
        seen.push(id);
        return inlineCtx.resolvePage(id);
      },
    };
    notionBlocksToBlockNote([block("child_database", INLINE_DB, { title: "Projects" })], spy);
    expect(seen).toEqual([INLINE_DB, KNOWN_PAGE, UNKNOWN_PAGE]);
  });

  it("encodes an inline table to Yjs state without error", () => {
    const { blocks } = notionBlocksToBlockNote([block("child_database", INLINE_DB, { title: "Projects" })], inlineCtx);
    expect(blocksToYDocState(blocks).byteLength).toBeGreaterThan(0);
  });
});
