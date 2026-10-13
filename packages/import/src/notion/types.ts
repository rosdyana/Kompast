/**
 * One page out of a Notion export zip ("Markdown & CSV" or "HTML"). Notion
 * names every page file `<Title> <32-hex id>.<ext>` and puts its sub-pages
 * in a sibling folder, so the zip's folder tree is the page tree.
 */
export interface NotionExportPage {
  /** Notion's block id, from the file name. Part of the idempotency key (see load.ts). */
  notionId: string;
  title: string;
  /** Emoji page icon, HTML exports only (Markdown exports drop it). Custom image icons are skipped. */
  icon: string | null;
  /** Path of the page file inside the export. Relative links in `body` resolve against it. */
  path: string;
  format: "html" | "markdown";
  /**
   * HTML: the whole exported document (apps/web picks out `.page-body`).
   * Markdown: the file minus its leading `# Title` line. A Markdown
   * export's database CSV becomes a Markdown table here.
   */
  body: string;
  /** notionId of the page whose sub-page folder this file sits in; null at the top of the export. */
  parentId: string | null;
  /** A Notion database (CSV in Markdown exports, a table page in HTML ones). Its rows are its sub-pages. */
  database: boolean;
}

export interface NotionExport {
  /** Parents always come before their children. */
  pages: NotionExportPage[];
  /**
   * Which page each page file is, by path, for resolving relative links.
   * Includes files dropped as duplicates (a database's view CSV), since
   * pages still link to those.
   */
  pageIdByPath: Map<string, string>;
  /** Every non-page file (images, attachments), by normalized path. */
  files: Map<string, Uint8Array>;
  /** Entries that weren't imported, for the report (e.g. a superseded database view CSV). */
  skipped: { path: string; reason: string }[];
}
