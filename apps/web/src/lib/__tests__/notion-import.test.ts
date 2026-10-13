import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { readNotionExport, type ImportedPageRef } from "@kompast/import";
import { createServerSchema } from "../blocknote-schema";
import { createNotionPageConverter, type UploadPageAsset } from "../notion-import";
import { IDS, notionHtmlExportZip, notionMarkdownExportZip } from "../../../../../packages/import/src/__tests__/fixtures/notion";

const editor = ServerBlockNoteEditor.create({ schema: createServerSchema() as any });

function decode(state: Uint8Array): any[] {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return editor.yDocToBlocks(doc, "document-store") as any[];
}

const allInline = (blocks: any[]): any[] =>
  blocks.flatMap((b) => [...(Array.isArray(b.content) ? b.content : []), ...allInline(b.children ?? [])]);

function setup(zip: Uint8Array) {
  const exp = readNotionExport(zip);
  const uploads: { pageId: string; fileName: string; size: number }[] = [];
  const upload: UploadPageAsset = async (pageId, fileName, data) => {
    uploads.push({ pageId, fileName, size: data.length });
    return `/api/page-assets/${pageId}/x-${fileName}`;
  };
  const refs = new Map<string, ImportedPageRef>(exp.pages.map((p) => [p.notionId, { pageId: `page_${p.notionId.slice(0, 4)}`, title: p.title, icon: p.icon }]));
  const convert = createNotionPageConverter(exp, upload);
  const run = (notionId: string) => convert(exp.pages.find((p) => p.notionId === notionId)!, { pageId: refs.get(notionId)!.pageId, linkedPage: (id) => refs.get(id) ?? null });
  return { run, uploads, refs };
}

describe("createNotionPageConverter", () => {
  it("converts Notion HTML: headings, page links → mentions, to-dos, callouts, toggles, images", async () => {
    const { run, uploads } = setup(notionHtmlExportZip());
    const result = await run(IDS.wiki);
    const blocks = decode(result.state);
    const types = blocks.map((b) => b.type);

    expect(blocks[0]).toMatchObject({ type: "heading", props: { level: 2 } });
    expect(types).not.toContain("header");
    expect(blocks.filter((b) => b.type === "checkListItem").map((b) => [b.content[0].text, b.props.checked])).toEqual([
      ["Get a laptop", true],
      ["Meet the team", false],
    ]);
    expect(blocks.find((b) => b.type === "quote")!.content[0].text).toContain("💡 Ask in #help");
    const toggle = blocks.find((b) => b.type === "toggleListItem")!;
    expect(toggle.content[0].text).toBe("FAQ");
    expect(toggle.children[0].content[0].text).toBe("Answers live here.");

    const image = blocks.find((b) => b.type === "image")!;
    expect(image.props.url).toBe(`/api/page-assets/page_0123/x-diagram.png`);
    expect(uploads).toEqual([{ pageId: "page_0123", fileName: "diagram.png", size: expect.any(Number) }]);
    expect(result.assetsUploaded).toBe(1);

    const mentions = allInline(blocks).filter((n) => n.type === "mention");
    expect(mentions.length).toBeGreaterThanOrEqual(2);
    expect(mentions[0].props).toEqual({ pageId: "page_aaaa", title: "Onboarding", icon: "👋" });
    expect(result.mentionedPageIds).toEqual(["page_aaaa"]);
    expect(allInline(blocks).find((n) => n.type === "link")).toMatchObject({ href: "https://example.com/docs" });
  });

  it("keeps a page's property table from the header, ahead of the body, and drops the repeated title", async () => {
    const { run } = setup(notionHtmlExportZip());
    const blocks = decode((await run(IDS.roadmap)).state);
    expect(blocks.map((b) => b.type).slice(0, 2)).toEqual(["table", "paragraph"]);
    expect(blocks[0].content.rows[0].cells.map((c: any) => c.content[0].text)).toEqual(["Status", "Planned"]);
    expect(allInline(blocks).some((n) => n.text === "Roadmap")).toBe(false);
  });

  it("links back up the tree with ../ and leaves a link to a page outside the import as plain text", async () => {
    const { run, refs } = setup(notionHtmlExportZip());
    expect((await run(IDS.onboarding)).mentionedPageIds).toEqual(["page_0123"]);

    refs.delete(IDS.wiki); // e.g. its creation failed
    const blocks = decode((await run(IDS.onboarding)).state);
    expect(allInline(blocks).map((n) => n.text ?? n.type).join("")).toBe("Back to Team Wiki.");
  });

  it("turns a relative link to a page that isn't in the export into plain text", async () => {
    const exp = readNotionExport(notionHtmlExportZip());
    const page = { ...exp.pages.find((p) => p.notionId === IDS.roadmap)!, body: `<div class="page-body"><p>See <a href="Gone%20${"1".repeat(32)}.html">Gone</a>.</p></div>` };
    const convert = createNotionPageConverter(exp, async () => "unused");
    const blocks = decode((await convert(page, { pageId: "p", linkedPage: () => null })).state);
    expect(allInline(blocks)).toEqual([{ type: "text", text: "See Gone.", styles: {} }]);
  });

  it("converts Notion Markdown: callout aside → quote, links to a database's view CSV, images, CSV tables", async () => {
    const { run, uploads } = setup(notionMarkdownExportZip());
    const notes = decode((await run(IDS.notes)).state);
    expect(allInline(notes).filter((n) => n.type === "mention").map((n) => n.props.title)).toEqual(["Child", "Tasks"]);
    expect(notes.find((b) => b.type === "quote")!.content[0].text).toContain("💡 Remember this");
    expect(notes.find((b) => b.type === "image")!.props.url).toBe("/api/page-assets/page_cccc/x-chart.png");
    expect(uploads.map((u) => u.fileName)).toEqual(["chart.png"]);

    const tasks = decode((await run(IDS.tasks)).state);
    const table = tasks.find((b) => b.type === "table")!;
    expect(table.content.rows).toHaveLength(3);
    expect(table.content.rows[2].cells[0].content[0].text).toBe("Ship, then rest");
  });
});
