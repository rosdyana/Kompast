import type { NotionAnnotations, NotionBlock, NotionPage, NotionPropertyValue, NotionRichText } from "./types";
import { displayTitle, emojiOf, normalizeNotionId, notionIdFromUrl, richTextPlain, titleOfProperties } from "./util";

/**
 * Notion blocks to BlockNote blocks, pure: no network, no DOM. The caller
 * fetches the block tree and supplies what the conversion can't know on its
 * own (which Notion pages became Kompast pages, who people are, which files
 * were already copied).
 *
 * Every block type emitted here exists in BlockNote 0.54's defaultBlockSpecs
 * (packages/editor's createServerSchema uses those), so the output is what the
 * editor and blocksToYDocState accept. Notion has no callout block in BlockNote:
 * a callout becomes a quote led by its emoji, carrying the callout's color.
 * Notion colors map to BlockNote's: `red` is the text color, `red_background`
 * the background, and "default" is left out.
 */

export type BlockNoteStyles = Record<string, string | boolean>;

export type InlineNode =
  | { type: "text"; text: string; styles: BlockNoteStyles }
  | { type: "link"; href: string; content: InlineNode[] }
  | { type: "mention"; props: { pageId: string; title: string; icon: string } };

export interface TableContent {
  type: "tableContent";
  columnWidths: number[];
  headerRows?: number;
  rows: { cells: InlineNode[][] }[];
}

export interface BlockNode {
  type: string;
  props: Record<string, unknown>;
  /** Inline content, or a table's rows. Absent for blocks with no content (divider, image, file). */
  content?: InlineNode[] | TableContent;
  children: BlockNode[];
}

/** A block as the fetcher returns it: the Notion block, with its children attached. */
export type NotionBlockWithChildren = NotionBlock & { children: NotionBlockWithChildren[] };

export interface PageRef {
  pageId: string;
  title: string;
  icon: string | null;
}

/** An inline database's schema (names and types, title first) and its rows, in the order the data source returned them. */
export interface InlineDatabase {
  properties: { name: string; type: string }[];
  rows: NotionPage[];
}

export interface NotionConvertContext {
  /** The Kompast page a Notion page became, or null when it wasn't imported (the reference becomes a notion.so link). */
  resolvePage(notionId: string): PageRef | null;
  /** A display name for a Notion user: the Kompast member's name when matched, else the Notion name, else "Notion user". */
  userName(notionUserId: string | null, fallbackName?: string | null): string;
  /** The stored copy of a Notion-hosted file block, or null when it wasn't copied. */
  assetUrl(blockId: string): { url: string; name: string } | null;
  /**
   * The table of an inline database (one the page shows in its body), read by the caller before conversion.
   * Null for a full-page database, or one that shouldn't be shown inline (too many rows, or unreadable): a link only.
   */
  inlineDatabase?(notionId: string): InlineDatabase | null;
}

export interface NotionConvertStats {
  /** Blocks of a type the importer doesn't know. Their text (if any) is kept as a paragraph. */
  unknownBlocks: number;
  /** Notion-hosted files that weren't copied. Each one leaves a "File not imported" paragraph. */
  filesNotImported: number;
}

const FILE_BLOCK_TYPES: Record<string, string> = { image: "image", file: "file", pdf: "file", video: "video", audio: "audio" };

function text(value: string, styles: BlockNoteStyles = {}): InlineNode {
  return { type: "text", text: value, styles };
}

function plainCell(value: string): InlineNode[] {
  return value ? [text(value)] : [];
}

/**
 * The colors BlockNote 0.54 accepts for textColor and backgroundColor (its
 * colors table in @blocknote/core). Notion's "default" is left out, so is
 * anything else.
 */
const BLOCKNOTE_COLORS = new Set(["gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"]);

/**
 * A Notion color as BlockNote's color props: `red` is the text color,
 * `red_background` the background. Empty for "default" or a color BlockNote
 * doesn't have. The same mapping serves inline annotations and block colors.
 */
function colorProps(color: unknown): Record<string, string> {
  if (typeof color !== "string" || color === "default") return {};
  const background = color.endsWith("_background");
  const name = background ? color.slice(0, -"_background".length) : color;
  if (!BLOCKNOTE_COLORS.has(name)) return {};
  return background ? { backgroundColor: name } : { textColor: name };
}

function stylesOf(a: NotionAnnotations | undefined): BlockNoteStyles {
  const styles: BlockNoteStyles = {};
  if (a?.bold) styles.bold = true;
  if (a?.italic) styles.italic = true;
  if (a?.strikethrough) styles.strike = true;
  if (a?.underline) styles.underline = true;
  if (a?.code) styles.code = true;
  Object.assign(styles, colorProps(a?.color));
  return styles;
}

function mentionNode(ref: PageRef): InlineNode {
  return { type: "mention", props: { pageId: ref.pageId, title: ref.title, icon: ref.icon ?? "" } };
}

function linkNodes(href: string, label: string, styles: BlockNoteStyles = {}): InlineNode[] {
  return [{ type: "link", href, content: [text(label || href, styles)] }];
}

function notionUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, "")}`;
}

function resolveRef(ctx: NotionConvertContext, rawId: string | null | undefined): PageRef | null {
  const id = normalizeNotionId(rawId);
  return id ? ctx.resolvePage(id) : null;
}

function richInline(items: NotionRichText[] | null | undefined, ctx: NotionConvertContext): InlineNode[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => richItemInline(item, ctx));
}

function richItemInline(item: NotionRichText, ctx: NotionConvertContext): InlineNode[] {
  const styles = stylesOf(item.annotations);
  const plain = item.plain_text ?? item.text?.content ?? "";
  if (item.type === "mention" && item.mention) {
    const m = item.mention;
    if (m.type === "page" || m.type === "database") {
      // A page or database that wasn't imported stays a link to Notion, so the text still goes somewhere.
      const targetId = m.type === "page" ? m.page?.id : (m.database as { id?: string } | undefined)?.id;
      const ref = resolveRef(ctx, targetId);
      if (ref) return [mentionNode(ref)];
      const id = normalizeNotionId(targetId);
      return id ? linkNodes(notionUrl(id), plain, styles) : plainCell(plain);
    }
    if (m.type === "user") {
      return plainCell(`@${ctx.userName(m.user?.id ?? null, m.user?.name ?? plain.replace(/^@/, ""))}`);
    }
  }
  if (item.type === "equation" && item.equation) return plainCell(`$${item.equation.expression}$`);
  const href = item.href ?? item.text?.link?.url ?? null;
  if (href) {
    const linked = notionIdFromUrl(href);
    const ref = linked ? resolveRef(ctx, linked) : null;
    if (ref) return [mentionNode(ref)];
    return linkNodes(href, plain, styles);
  }
  return plain ? [text(plain, styles)] : [];
}

function valueOf(block: NotionBlock): Record<string, any> {
  const value = block[block.type];
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

/** The first rich text array among the given fields of a block value. */
function richOf(v: Record<string, any>, ...keys: string[]): NotionRichText[] {
  for (const key of keys) if (Array.isArray(v[key])) return v[key] as NotionRichText[];
  return [];
}

function nameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

function languageOf(raw: unknown): string {
  const lang = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return !lang || lang === "plain text" ? "text" : lang;
}

function fileNameOf(block: NotionBlock, v: Record<string, any>): string {
  if (typeof v.name === "string" && v.name) return v.name;
  return nameFromUrl(v.file?.url ?? v.external?.url) ?? block.type;
}

function fileBlocks(block: NotionBlock, v: Record<string, any>, ctx: NotionConvertContext, stats: NotionConvertStats): BlockNode[] {
  const blockType = FILE_BLOCK_TYPES[block.type] ?? "file";
  const caption = richTextPlain(v.caption);
  if (v.type === "external" && typeof v.external?.url === "string") {
    const url: string = v.external.url;
    return [{ type: blockType, props: { url, name: fileNameOf(block, v), caption }, children: [] }];
  }
  const asset = v.type === "file" ? ctx.assetUrl(block.id) : null;
  if (asset) return [{ type: blockType, props: { url: asset.url, name: asset.name, caption }, children: [] }];
  stats.filesNotImported++;
  return [paragraphOf([text(`File not imported: ${fileNameOf(block, v)}`)])];
}

function paragraphOf(content: InlineNode[], children: BlockNode[] = []): BlockNode {
  return { type: "paragraph", props: {}, content, children };
}

function tableBlocks(block: NotionBlockWithChildren, v: Record<string, any>, ctx: NotionConvertContext): BlockNode[] {
  const rowBlocks = (block.children ?? []).filter((c) => c.type === "table_row" && !c.in_trash);
  const rows = rowBlocks.map((row) => ({ cells: (valueOf(row).cells ?? []).map((cell: NotionRichText[]) => richInline(cell, ctx)) }));
  const width = Math.max(0, ...rows.map((r) => r.cells.length));
  if (width === 0) return [];
  for (const row of rows) while (row.cells.length < width) row.cells.push([]);
  const content: TableContent = {
    type: "tableContent",
    columnWidths: [],
    rows,
    ...(v.has_column_header === true ? { headerRows: 1 } : {}),
  };
  return [{ type: "table", props: { textColor: "default" }, content, children: [] }];
}

function convertBlock(block: NotionBlockWithChildren, ctx: NotionConvertContext, stats: NotionConvertStats): BlockNode[] {
  if (block.in_trash) return [];
  const v = valueOf(block);
  const kids = () => convertBlocks(block.children ?? [], ctx, stats);
  const content = () => richInline(v.rich_text, ctx);

  switch (block.type) {
    case "paragraph":
      return [{ type: "paragraph", props: colorProps(v.color), content: content(), children: kids() }];
    case "heading_1":
    case "heading_2":
    case "heading_3":
    // Notion added heading_4; BlockNote's heading takes levels 1-6, so these map one to one.
    case "heading_4":
    case "heading_5":
    case "heading_6": {
      const props: Record<string, unknown> = { level: Number(block.type.slice(-1)), ...colorProps(v.color) };
      if (v.is_toggleable === true) props.isToggleable = true;
      return [{ type: "heading", props, content: content(), children: kids() }];
    }
    case "bulleted_list_item":
      return [{ type: "bulletListItem", props: colorProps(v.color), content: content(), children: kids() }];
    case "numbered_list_item":
      return [{ type: "numberedListItem", props: colorProps(v.color), content: content(), children: kids() }];
    case "to_do":
      return [{ type: "checkListItem", props: { checked: v.checked === true, ...colorProps(v.color) }, content: content(), children: kids() }];
    case "toggle":
      return [{ type: "toggleListItem", props: colorProps(v.color), content: content(), children: kids() }];
    case "quote":
      return [{ type: "quote", props: colorProps(v.color), content: content(), children: kids() }];
    case "callout": {
      // A callout's color (usually gray_background) becomes the quote's background.
      const emoji = emojiOf(v.icon);
      const lead = emoji ? [text(`${emoji} `)] : [];
      return [{ type: "quote", props: colorProps(v.color), content: [...lead, ...content()], children: kids() }];
    }
    case "code": {
      const code = richTextPlain(v.rich_text);
      return [{ type: "codeBlock", props: { language: languageOf(v.language) }, content: code ? [text(code)] : [], children: [] }];
    }
    case "equation": {
      const expression = typeof v.expression === "string" ? v.expression : "";
      return [{ type: "codeBlock", props: { language: "latex" }, content: expression ? [text(expression)] : [], children: [] }];
    }
    case "divider":
      return [{ type: "divider", props: {}, children: [] }];
    case "table":
      return tableBlocks(block, v, ctx);
    case "table_row":
      return []; // only meaningful inside a table, which reads its rows
    case "image":
    case "file":
    case "pdf":
    case "video":
    case "audio":
      return fileBlocks(block, v, ctx, stats);
    case "bookmark": {
      const url = typeof v.url === "string" ? v.url : "";
      return url ? [paragraphOf(linkNodes(url, richTextPlain(v.caption)))] : [];
    }
    case "embed":
    case "link_preview": {
      const url = typeof v.url === "string" ? v.url : "";
      return url ? [paragraphOf(linkNodes(url, url))] : [];
    }
    case "link_to_page": {
      if (v.type === "page_id") {
        const ref = resolveRef(ctx, v.page_id);
        if (ref) return [paragraphOf([mentionNode(ref)])];
        const id = normalizeNotionId(v.page_id);
        return id ? [paragraphOf(linkNodes(notionUrl(id), "Linked Notion page"))] : [];
      }
      if (v.type === "database_id") {
        const id = normalizeNotionId(v.database_id);
        return id ? [paragraphOf(linkNodes(notionUrl(id), "Linked Notion database"))] : [];
      }
      return [];
    }
    case "column_list":
    case "column":
    case "synced_block":
      return kids();
    case "child_page":
    case "child_database": {
      // Sub-pages and sub-databases are imported as pages of their own. Their link sits where the block is.
      const id = normalizeNotionId(block.id);
      if (!id) return [];
      const ref = resolveRef(ctx, id);
      const link = ref
        ? [mentionNode(ref)]
        : linkNodes(notionUrl(id), displayTitle(block.type === "child_database" ? "database" : "page", typeof v.title === "string" ? v.title : ""));
      // An inline database also shows its table here, after the link to its page (its rows are sub-pages of that page).
      const inline = block.type === "child_database" ? (ctx.inlineDatabase?.(id) ?? null) : null;
      if (!inline) return [paragraphOf(link)];
      return [paragraphOf(link), databaseTable(inline.properties, inline.rows, ctx)];
    }
    case "table_of_contents":
    case "breadcrumb":
      return [];
    default: {
      stats.unknownBlocks++;
      const rich = richOf(v, "rich_text", "title", "caption");
      const inline = richInline(rich, ctx);
      return [...(inline.length ? [paragraphOf(inline)] : []), ...kids()];
    }
  }
}

function convertBlocks(blocks: NotionBlockWithChildren[], ctx: NotionConvertContext, stats: NotionConvertStats): BlockNode[] {
  return blocks.flatMap((block) => convertBlock(block, ctx, stats));
}

/** Converts a fetched block tree to BlockNote blocks. */
export function notionBlocksToBlockNote(blocks: NotionBlockWithChildren[], ctx: NotionConvertContext): { blocks: BlockNode[]; stats: NotionConvertStats } {
  const stats: NotionConvertStats = { unknownBlocks: 0, filesNotImported: 0 };
  return { blocks: convertBlocks(blocks, ctx, stats), stats };
}

// ── Properties and database tables ──────────────────────────────────────────

function arr<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function dateText(d: { start?: string | null; end?: string | null } | null | undefined): string {
  if (!d?.start) return "";
  return d.end ? `${d.start} → ${d.end}` : d.start;
}

function plainOf(nodes: InlineNode[]): string {
  return nodes
    .map((n) => (n.type === "text" ? n.text : n.type === "link" ? plainOf(n.content) : n.props.title))
    .join("");
}

function formulaText(v: Record<string, any> | null | undefined): string {
  switch (v?.type) {
    case "string":
      return typeof v.string === "string" ? v.string : "";
    case "number":
      return v.number == null ? "" : String(v.number);
    case "boolean":
      return v.boolean === true ? "✓" : "";
    case "date":
      return dateText(v.date);
    default:
      return "";
  }
}

function rollupText(v: Record<string, any> | null | undefined, ctx: NotionConvertContext): string {
  switch (v?.type) {
    case "number":
      return v.number == null ? "" : String(v.number);
    case "date":
      return dateText(v.date);
    case "array":
      return arr<NotionPropertyValue>(v.array)
        .map((item) => plainOf(propertyValueText(item, ctx)))
        .filter(Boolean)
        .join(", ");
    default:
      return "";
  }
}

function relationCell(items: { id?: string }[], ctx: NotionConvertContext): InlineNode[] {
  const out: InlineNode[] = [];
  items.forEach((item, i) => {
    if (i > 0) out.push(text(", "));
    const ref = resolveRef(ctx, item.id);
    out.push(ref ? mentionNode(ref) : text(item.id ?? ""));
  });
  return out;
}

/** A select, status or multi_select value: its name, and the Notion color of its option. */
interface OptionValue {
  name?: string;
  color?: string;
}

/**
 * Option values as text runs, joined with ", ". Each run takes its option's
 * color as the backgroundColor ("default", or a color BlockNote doesn't have,
 * leaves it unstyled). Options with no name are skipped.
 */
function optionRuns(options: OptionValue[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const option of options) {
    const name = option?.name ?? "";
    if (!name) continue;
    if (out.length > 0) out.push(text(", "));
    out.push(text(name, colorProps(`${option.color ?? "default"}_background`)));
  }
  return out;
}

/**
 * A property's value as the inline content of a table cell. Relations become
 * mentions to the imported pages (the id, when the page wasn't imported);
 * select, status and multi_select values are text runs colored by their
 * option; most other types are plain text. Unknown types are empty.
 */
export function propertyValueText(prop: NotionPropertyValue | null | undefined, ctx: NotionConvertContext): InlineNode[] {
  if (!prop) return [];
  const v = (prop as Record<string, any>)[prop.type];
  switch (prop.type) {
    case "title":
    case "rich_text":
      return richInline(v, ctx);
    case "number":
      return plainCell(v == null ? "" : String(v));
    case "select":
    case "status":
      return optionRuns(v ? [v] : []);
    case "multi_select":
      return optionRuns(arr<OptionValue>(v));
    case "date":
      return plainCell(dateText(v));
    case "people":
      return plainCell(arr<{ id?: string; name?: string }>(v).map((p) => ctx.userName(p.id ?? null, p.name ?? null)).join(", "));
    case "checkbox":
      return plainCell(v === true ? "✓" : "");
    case "url":
    case "email":
    case "phone_number":
      return plainCell(typeof v === "string" ? v : "");
    case "formula":
      return plainCell(formulaText(v));
    case "relation":
      return relationCell(arr<{ id?: string }>(v), ctx);
    case "rollup":
      return plainCell(rollupText(v, ctx));
    case "files":
      return plainCell(arr<{ name?: string }>(v).map((f) => f.name ?? "").filter(Boolean).join(", "));
    case "created_time":
    case "last_edited_time":
      return plainCell(typeof v === "string" ? v : "");
    case "created_by":
    case "last_edited_by":
      return plainCell(ctx.userName(v?.id ?? null, v?.name ?? null));
    case "unique_id":
      return plainCell(v?.prefix ? `${v.prefix}-${v.number ?? ""}` : v?.number == null ? "" : String(v.number));
    case "verification":
      return plainCell(typeof v?.state === "string" ? v.state : "");
    default:
      return [];
  }
}

function tableOf(header: InlineNode[][], body: InlineNode[][][]): BlockNode {
  const content: TableContent = {
    type: "tableContent",
    columnWidths: [],
    headerRows: 1,
    rows: [{ cells: header }, ...body.map((cells) => ({ cells }))],
  };
  return { type: "table", props: { textColor: "default" }, content, children: [] };
}

/**
 * A database row's properties as a two-column table (Property | Value), for
 * the top of the row's page. Null when the row has no properties.
 */
export function propertiesTable(properties: Record<string, NotionPropertyValue> | null | undefined, ctx: NotionConvertContext): BlockNode | null {
  const entries = Object.entries(properties ?? {});
  if (entries.length === 0) return null;
  const header = [[text("Property", { bold: true })], [text("Value", { bold: true })]];
  return tableOf(
    header,
    entries.map(([name, prop]) => [plainCell(name), propertyValueText(prop, ctx)]),
  );
}

/**
 * A database as a table: one row per row page, the title column first (each
 * title is a mention to that row's Kompast page), then the other properties
 * in schema order. With no schema given, the columns are the properties the
 * rows carry.
 */
export function databaseTable(schema: { name: string; type: string }[], rows: NotionPage[], ctx: NotionConvertContext): BlockNode {
  let columns = schema;
  if (columns.length === 0) {
    const seen = new Map<string, string>();
    for (const row of rows) for (const [name, prop] of Object.entries(row.properties ?? {})) if (!seen.has(name)) seen.set(name, prop.type);
    columns = [...seen].map(([name, type]) => ({ name, type }));
  }
  if (columns.length === 0) columns = [{ name: "Name", type: "title" }];
  const titleColumn = columns.find((c) => c.type === "title") ?? columns[0]!;
  const ordered = [titleColumn, ...columns.filter((c) => c !== titleColumn)];

  const header = ordered.map((c) => [text(c.name, { bold: true })]);
  const body = rows.map((row) => {
    const titleRef = resolveRef(ctx, row.id);
    const titleCell = titleRef ? [mentionNode(titleRef)] : plainCell(titleOfProperties(row.properties));
    return ordered.map((col, i) => (i === 0 ? titleCell : propertyValueText(row.properties?.[col.name], ctx)));
  });
  return tableOf(header, body);
}

