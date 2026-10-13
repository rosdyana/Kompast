import * as Y from "yjs";
import { JSDOM } from "jsdom";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { getStorageDriver } from "@kompast/storage";
import { linkedNotionId, resolveExportPath, type NotionExport, type NotionExportPage, type NotionPageConverter } from "@kompast/import";
import { createServerSchema } from "./blocknote-schema";
import { contentTypeFor } from "./content-type";

/**
 * Stand-in href for a link to another page in the same export. BlockNote
 * keeps https links as-is, so it survives HTML/Markdown parsing and is
 * swapped for a real page `mention` once the blocks exist. `.invalid` is
 * reserved, so it can never collide with a real link.
 */
const PAGE_LINK_PREFIX = "https://kompast.invalid/notion/";

export type UploadPageAsset = (pageId: string, fileName: string, data: Uint8Array) => Promise<string>;

/**
 * Stores an imported image/attachment under the page and returns the URL
 * the doc should point at. /api/page-assets checks the reader can see the
 * page before handing out a short-lived storage URL, so the asset is
 * exactly as private as the page.
 */
export const uploadPageAsset: UploadPageAsset = async (pageId, fileName, data) => {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "file";
  const name = `${crypto.randomUUID().slice(0, 8)}-${safeName}`;
  await getStorageDriver().putObject(`page-assets/${pageId}/${name}`, Buffer.from(data), { contentType: contentTypeFor(name) });
  return `/api/page-assets/${pageId}/${encodeURIComponent(name)}`;
};

/**
 * Builds the converter runNotionImport calls once per created page:
 * Notion's HTML (or Markdown) → BlockNote blocks → Yjs, the same encoding
 * the collab server stores. Notion-specific markup BlockNote doesn't know
 * is rewritten into plain HTML it does: to-dos into checkboxes, callouts
 * into quotes, equations into LaTeX code blocks. Colors and column layouts
 * are dropped (columns are flattened into one).
 */
export function createNotionPageConverter(exp: NotionExport, upload: UploadPageAsset = uploadPageAsset): NotionPageConverter {
  const editor = ServerBlockNoteEditor.create({ schema: createServerSchema() as any });

  return async (page, ctx) => {
    let assetsUploaded = 0;
    const uploaded = new Map<string, string>();
    /**
     * Rewrites one href/src: another exported page, a file in the export,
     * or left alone (external). A relative link to something that isn't in
     * the export (a partial export) would be dead, so a link becomes plain
     * text instead (the placeholder resolves to no page).
     */
    const rewrite = async (href: string, kind: "link" | "image"): Promise<string | null> => {
      const notionId = linkedNotionId(exp, page.path, href);
      if (notionId) return `${PAGE_LINK_PREFIX}${notionId}`;
      const path = resolveExportPath(page.path, href);
      const data = path ? exp.files.get(path) : undefined;
      if (path && !data && kind === "link") return `${PAGE_LINK_PREFIX}missing`;
      if (!path || !data) return null;
      if (!uploaded.has(path)) {
        uploaded.set(path, await upload(ctx.pageId, path.slice(path.lastIndexOf("/") + 1), data));
        assetsUploaded++;
      }
      return uploaded.get(path)!;
    };

    const blocks =
      page.format === "html"
        ? await editor.tryParseHTMLToBlocks(await notionHtmlToPlainHtml(page, rewrite))
        : await editor.tryParseMarkdownToBlocks(await notionMarkdownToPlainMarkdown(page, rewrite));

    const mentioned = new Set<string>();
    const withMentions = replacePageLinks(blocks, ctx.linkedPage, mentioned);
    const ydoc = editor.blocksToYDoc(withMentions as any, "document-store");
    return { state: Y.encodeStateAsUpdate(ydoc), mentionedPageIds: [...mentioned], assetsUploaded };
  };
}

type Rewrite = (href: string, kind: "link" | "image") => Promise<string | null>;

async function notionHtmlToPlainHtml(page: NotionExportPage, rewrite: Rewrite): Promise<string> {
  const { document } = new JSDOM(page.body).window;
  const root = document.querySelector(".page-body") ?? document.querySelector("article") ?? document.body;
  // The header repeats the title and icon (kept on the page row instead),
  // but it also holds a page's description and a database row's property
  // table, which are content: move those to the top of the body.
  const header = document.querySelector("header");
  if (header && !root.contains(header)) {
    root.prepend(...Array.from(header.querySelectorAll(".page-description, table.properties")));
    header.remove();
  }
  root.querySelectorAll("header, style, script, svg, nav.table_of_contents, .table_of_contents").forEach((el) => el.remove());

  // Notion's to-do: <li><div class="checkbox checkbox-on"></div> <span>text</span></li>
  root.querySelectorAll("ul.to-do-list > li").forEach((li) => {
    const checkbox = li.querySelector(".checkbox");
    const input = document.createElement("input");
    input.type = "checkbox";
    if (checkbox?.classList.contains("checkbox-on")) input.setAttribute("checked", "");
    checkbox?.remove();
    li.prepend(input);
  });

  // Toggles are <ul class="toggle"><li><details>…, and BlockNote reads <details> as a toggle on its own.
  root.querySelectorAll("ul.toggle").forEach((ul) => ul.replaceWith(...Array.from(ul.querySelectorAll(":scope > li")).flatMap((li) => Array.from(li.childNodes))));

  root.querySelectorAll("figure.callout").forEach((figure) => {
    const quote = document.createElement("blockquote");
    const icon = figure.querySelector(".icon")?.textContent?.trim();
    const body = figure.querySelector(":scope > div:last-child") ?? figure;
    quote.innerHTML = `${icon ? `${icon} ` : ""}${body.innerHTML}`;
    figure.replaceWith(quote);
  });

  root.querySelectorAll("figure.equation").forEach((figure) => {
    const tex = figure.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? figure.textContent ?? "";
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-latex";
    code.textContent = tex.trim();
    pre.append(code);
    figure.replaceWith(pre);
  });
  root.querySelectorAll(".notion-text-equation-token").forEach((span) => {
    const tex = span.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? span.textContent ?? "";
    span.replaceWith(document.createTextNode(`$${tex.trim()}$`));
  });

  // Bookmarks render as a card; keep the link.
  root.querySelectorAll("figure:has(a.bookmark)").forEach((figure) => {
    const a = figure.querySelector("a.bookmark")!;
    const p = document.createElement("p");
    const link = document.createElement("a");
    link.href = a.getAttribute("href") ?? "";
    link.textContent = a.querySelector(".bookmark-title")?.textContent?.trim() || link.href;
    p.append(link);
    figure.replaceWith(p);
  });

  // Images come wrapped in a link to themselves, which BlockNote would read as a link, not an image.
  root.querySelectorAll("a:has(> img)").forEach((a) => a.replaceWith(...Array.from(a.childNodes)));
  root.querySelectorAll(".column-list, .column").forEach((el) => el.replaceWith(...Array.from(el.childNodes)));

  for (const img of Array.from(root.querySelectorAll("img[src]"))) {
    const next = await rewrite(img.getAttribute("src")!, "image");
    if (next) img.setAttribute("src", next);
  }
  for (const a of Array.from(root.querySelectorAll("a[href]"))) {
    const next = await rewrite(a.getAttribute("href")!, "link");
    if (next) a.setAttribute("href", next);
  }
  return root.innerHTML;
}

async function notionMarkdownToPlainMarkdown(page: NotionExportPage, rewrite: Rewrite): Promise<string> {
  // Callouts are the one block Notion's Markdown export leaves as raw HTML.
  let markdown = page.body.replace(/<aside>\s*([\s\S]*?)\s*<\/aside>/g, (_, inner: string) =>
    inner
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n"),
  );
  const target = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g;
  const replacements = new Map<string, string>();
  for (const [, bang, , href] of markdown.matchAll(target)) {
    const kind = bang ? "image" : "link";
    if (replacements.has(`${kind}:${href}`)) continue;
    const next = await rewrite(href!, kind);
    if (next) replacements.set(`${kind}:${href}`, next);
  }
  markdown = markdown.replace(target, (whole, bang: string, text: string, href: string) => {
    const next = replacements.get(`${bang ? "image" : "link"}:${href}`);
    return next ? `${bang}[${text}](${next})` : whole;
  });
  return markdown;
}

/**
 * Swaps every placeholder link for a page `mention` (the same inline node
 * the editor inserts for @page), in paragraphs and table cells alike. A
 * link to a page that didn't make it into the import stays as its text.
 */
function replacePageLinks(blocks: any[], linkedPage: Parameters<NotionPageConverter>[1]["linkedPage"], mentioned: Set<string>): any[] {
  const inline = (content: any[]): any[] =>
    content.flatMap((node) => {
      if (node?.type !== "link" || typeof node.href !== "string" || !node.href.startsWith(PAGE_LINK_PREFIX)) return [node];
      const target = linkedPage(node.href.slice(PAGE_LINK_PREFIX.length));
      if (!target) return node.content ?? [];
      mentioned.add(target.pageId);
      return [{ type: "mention", props: { pageId: target.pageId, title: target.title, icon: target.icon ?? "" } }];
    });

  return blocks.map((block) => {
    let content = block.content;
    if (Array.isArray(content)) content = inline(content);
    else if (content?.type === "tableContent") {
      content = {
        ...content,
        rows: content.rows.map((row: any) => ({
          ...row,
          cells: row.cells.map((cell: any) => (Array.isArray(cell) ? inline(cell) : { ...cell, content: inline(cell.content ?? []) })),
        })),
      };
    }
    return { ...block, content, children: block.children ? replacePageLinks(block.children, linkedPage, mentioned) : block.children };
  });
}
