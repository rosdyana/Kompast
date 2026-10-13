import { unzipSync, strFromU8 } from "fflate";
import type { NotionExport, NotionExportPage } from "./types";

/** A sync, in-request import (like JIRA's) has to stop somewhere; past this, split the export (per top-level page). */
export const MAX_NOTION_PAGES = 2000;

const NOTION_ID = /^(.*?)\s*([0-9a-f]{32})$/i;
const NOTION_URL_ID = /([0-9a-f]{32})(?:[?#]|$)/i;

/**
 * Reads a Notion export zip. Workspace exports wrap the real content in a
 * zip inside the zip, and big ones are split into `...-Part-N.zip` files
 * that all share one folder tree, so nested zips are unpacked in place and
 * merged rather than kept as separate subtrees.
 */
export function readNotionExport(zip: Uint8Array): NotionExport {
  const entries = new Map<string, Uint8Array>();
  collectEntries(zip, entries, 0);
  return parseNotionEntries(entries);
}

function collectEntries(zip: Uint8Array, out: Map<string, Uint8Array>, depth: number) {
  if (depth > 3) throw new Error("Notion export is nested more than 3 zips deep");
  for (const [rawPath, data] of Object.entries(unzipSync(zip))) {
    const path = normalizePath(rawPath);
    if (!path || rawPath.endsWith("/") || path.startsWith("__MACOSX/") || basename(path) === ".DS_Store") continue;
    if (path.toLowerCase().endsWith(".zip")) collectEntries(data, out, depth + 1);
    else out.set(path, data);
  }
}

/** Exported for tests, which build entries directly instead of zipping them. */
export function parseNotionEntries(entries: Map<string, Uint8Array>): NotionExport {
  const files = new Map<string, Uint8Array>();
  const skipped: NotionExport["skipped"] = [];
  const byId = new Map<string, NotionExportPage>();
  const pageIdByPath = new Map<string, string>();

  for (const [path, data] of entries) {
    const ext = extension(path);
    if (ext !== "html" && ext !== "md" && ext !== "csv") {
      files.set(path, data);
      continue;
    }
    // Markdown exports write a database twice: `<name> <id>.csv` (the
    // current view's rows) and `<name> <id>_all.csv` (every row). Keep _all.
    const isAllCsv = ext === "csv" && basename(path).endsWith("_all.csv");
    const { title, notionId } = splitStem(pageStem(path), path);

    pageIdByPath.set(path, notionId);
    const page = toPage(path, ext as "html" | "md" | "csv", title, notionId, strFromU8(data));
    const existing = byId.get(notionId);
    if (existing && !prefer(page, existing, isAllCsv)) {
      skipped.push({ path, reason: `duplicate of ${existing.path}` });
      continue;
    }
    if (existing) skipped.push({ path: existing.path, reason: `superseded by ${path}` });
    byId.set(notionId, page);
  }

  const pages = [...byId.values()];
  assignParents(pages);
  return { pages: orderParentsFirst(pages), pageIdByPath, files, skipped };
}

function toPage(path: string, ext: "html" | "md" | "csv", fileTitle: string, notionId: string, text: string): NotionExportPage {
  if (ext === "html") {
    return {
      notionId,
      title: htmlTitle(text) ?? fileTitle,
      icon: htmlIcon(text),
      path,
      format: "html",
      body: text,
      parentId: null,
      database: /<table[^>]*class="[^"]*collection-content/.test(text),
    };
  }
  if (ext === "csv") {
    return { notionId, title: fileTitle, icon: null, path, format: "markdown", body: csvToMarkdownTable(text), parentId: null, database: true };
  }
  const heading = /^﻿?#\s+(.+)\r?\n?/.exec(text);
  return {
    notionId,
    title: heading ? heading[1]!.trim() : fileTitle,
    icon: null,
    path,
    format: "markdown",
    body: heading ? text.slice(heading[0].length) : text,
    parentId: null,
    database: false,
  };
}

/** Which of two files with the same Notion id to keep: a page over a CSV of it, and `_all.csv` over a view CSV. */
function prefer(candidate: NotionExportPage, existing: NotionExportPage, candidateIsAllCsv: boolean) {
  const rank = (p: NotionExportPage) => (p.format === "html" ? 3 : p.database ? 1 : 2);
  if (rank(candidate) !== rank(existing)) return rank(candidate) > rank(existing);
  return candidate.database && candidateIsAllCsv;
}

function splitStem(stem: string, path: string) {
  const match = NOTION_ID.exec(stem);
  if (match) return { title: match[1]!.trim() || "Untitled", notionId: match[2]!.toLowerCase() };
  // Not a Notion-named file (a hand-zipped folder, an old export). Its path
  // is still stable across re-runs of the same zip, so it can stand in.
  return { title: stem.trim() || "Untitled", notionId: `path:${path}` };
}

/**
 * A page's sub-pages live in a folder next to it. Older exports name the
 * folder exactly like the file (`Title <id>/`), newer ones drop the id
 * (`Title/`), so both are tried. Anything without a matching page folder
 * (the export's own top folder, "Private & Shared/") is see-through:
 * pages inside attach to the nearest page folder above, or the root.
 */
function assignParents(pages: NotionExportPage[]) {
  const folderOwner = new Map<string, string>();
  const titleFolderUses = new Map<string, number>();
  const titleFolder = (page: NotionExportPage) => join(dirname(page.path), splitStem(pageStem(page.path), page.path).title);
  for (const page of pages) titleFolderUses.set(titleFolder(page), (titleFolderUses.get(titleFolder(page)) ?? 0) + 1);
  for (const page of pages) {
    folderOwner.set(join(dirname(page.path), pageStem(page.path)), page.notionId);
    // Two pages titled alike in one folder can't both own `Title/`, so neither does.
    if (titleFolderUses.get(titleFolder(page)) === 1) folderOwner.set(titleFolder(page), page.notionId);
  }
  for (const page of pages) {
    let dir = dirname(page.path);
    while (dir) {
      const owner = folderOwner.get(dir);
      if (owner && owner !== page.notionId) {
        page.parentId = owner;
        break;
      }
      dir = dirname(dir);
    }
  }
}

/**
 * Parents first, so the loader can always hand createPage an existing
 * parent. Siblings follow the order their links appear in the parent's
 * body (Notion lists sub-pages where they sit in the page), then title.
 */
function orderParentsFirst(pages: NotionExportPage[]): NotionExportPage[] {
  const byId = new Map(pages.map((p) => [p.notionId, p]));
  const children = new Map<string | null, NotionExportPage[]>();
  for (const page of pages) {
    const parentId = page.parentId && byId.has(page.parentId) ? page.parentId : null;
    page.parentId = parentId;
    children.set(parentId, [...(children.get(parentId) ?? []), page]);
  }
  const ordered: NotionExportPage[] = [];
  const visit = (parentId: string | null) => {
    const parentBody = parentId ? byId.get(parentId)!.body : "";
    const position = (p: NotionExportPage) => {
      const at = parentBody.indexOf(p.notionId);
      return at === -1 ? Number.MAX_SAFE_INTEGER : at;
    };
    const siblings = (children.get(parentId) ?? []).sort((a, b) => position(a) - position(b) || a.title.localeCompare(b.title));
    for (const page of siblings) {
      ordered.push(page);
      visit(page.notionId);
    }
  };
  visit(null);
  return ordered;
}

/**
 * Resolves a link/src found in `fromPath`'s body to a path inside the
 * export, or null for anything external (http, mailto, in-page anchors).
 * Notion URL-encodes these (`My%20Page%20<id>.html`).
 */
export function resolveExportPath(fromPath: string, href: string): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) return null;
  let decoded = href.split("#")[0]!.split("?")[0]!;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // A literal "%" in a file name; use the href as written.
  }
  return normalizePath(join(dirname(fromPath), decoded));
}

/** The Notion page an href points at: a relative link to another exported file, or a notion.so URL carrying a page id. */
export function linkedNotionId(exp: NotionExport, fromPath: string, href: string): string | null {
  const path = resolveExportPath(fromPath, href);
  if (path) return exp.pageIdByPath.get(path) ?? null;
  if (/^https?:\/\/([a-z0-9-]+\.)?notion\.(so|site)\//i.test(href)) {
    const id = NOTION_URL_ID.exec(href.replace(/-/g, ""))?.[1]?.toLowerCase();
    return id && exp.pages.some((p) => p.notionId === id) ? id : null;
  }
  return null;
}

function htmlTitle(html: string): string | null {
  const match = /<h1[^>]*class="[^"]*page-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(html) ?? /<title>([\s\S]*?)<\/title>/i.exec(html);
  const title = match ? decodeEntities(match[1]!.replace(/<[^>]+>/g, "")).trim() : "";
  return title || null;
}

function htmlIcon(html: string): string | null {
  const match = /class="[^"]*page-header-icon[^"]*"[^>]*>\s*<span[^>]*class="icon"[^>]*>([^<]{1,16})<\/span>/i.exec(html);
  return match ? decodeEntities(match[1]!).trim() || null : null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** RFC 4180 CSV (quoted fields, doubled quotes, newlines inside quotes) to a GitHub Markdown table. */
export function csvToMarkdownTable(csv: string): string {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const text = csv.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim()));
  if (nonEmpty.length === 0) return "";
  const width = Math.max(...nonEmpty.map((r) => r.length));
  const cell = (c: string | undefined) => (c ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(" | ")} |`;
  const [header, ...body] = nonEmpty;
  return [line(header!), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(line)].join("\n") + "\n";
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function join(dir: string, name: string) {
  return dir ? `${dir}/${name}` : name;
}

function dirname(path: string) {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** File name minus extension, and minus a database CSV's `_all` suffix, so it matches the rows folder. */
function pageStem(path: string) {
  const name = basename(path);
  const at = name.lastIndexOf(".");
  const stem = at === -1 ? name : name.slice(0, at);
  return extension(path) === "csv" ? stem.replace(/_all$/, "") : stem;
}

function extension(path: string): string {
  const name = basename(path);
  const at = name.lastIndexOf(".");
  return at === -1 ? "" : name.slice(at + 1).toLowerCase();
}
