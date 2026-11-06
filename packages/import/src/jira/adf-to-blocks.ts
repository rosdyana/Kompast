import { adfToPlainText } from "./adf";

/**
 * Atlassian Document Format (JIRA's rich-text JSON, for descriptions and comment
 * bodies) → BlockNote's stored Block[] JSON, the shape the editor reads and writes
 * (descriptionJson / bodyJson). Plain JSON only: no @blocknote, no jsdom, so it
 * runs in the importer's transaction and in tests alike.
 *
 * Nothing is dropped silently. A node this converter doesn't know becomes a
 * paragraph of its plain text and is counted in stats.unknownNodes. Media that
 * matches no attachment becomes a paragraph saying so.
 *
 * Attachments: image and file blocks point at the JIRA attachment's `content` URL
 * (`…/rest/api/3/attachment/content/<id>`), which needs JIRA auth to load. Those
 * URLs won't render in Kompast until Phase 4 rewrites them to stored copies. The
 * JIRA attachment id is in that URL, so Phase 4 can match them reliably.
 */

// ── Output: BlockNote's stored shape ────────────────────────────────────────

export type BlockNoteStyles = Record<string, string | boolean>;

export type InlineNode =
  | { type: "text"; text: string; styles: BlockNoteStyles }
  | { type: "link"; href: string; content: InlineNode[] }
  | { type: "userMention"; props: { userId: string; name: string } }
  | { type: "issueMention"; props: { issueId: string; projectKey: string; keySeq: string; title: string; teamId: string } };

export interface TableContentNode {
  type: "tableContent";
  columnWidths: never[];
  headerRows?: number;
  rows: { cells: InlineNode[][] }[];
}

export interface BlockNode {
  type: string;
  props: Record<string, unknown>;
  /** Absent for blocks BlockNote stores without inline content (image, file, divider). */
  content?: InlineNode[] | TableContentNode;
  children: BlockNode[];
}

// ── Context ─────────────────────────────────────────────────────────────────

export interface AdfAttachment {
  id: string;
  filename: string;
  /** The attachment's content URL (needs JIRA auth; see the header). */
  content: string;
  mimeType?: string;
}

export interface AdfBlockContext {
  /** Resolves a JIRA accountId to a Kompast user. Null: the mention stays plain "@Name" text. */
  resolveUser: (accountId: string) => { userId: string; name: string } | null;
  /** e.g. "https://x.atlassian.net", no trailing slash. Links to `<this>/browse/<KEY>-<n>` can become issue mentions. */
  jiraBaseUrl?: string;
  /** The migrated JIRA project's key. Its keys are the only ones issueKeyNumberFor answers for. */
  projectKeyJira: string;
  /** The Kompast project the mentions point into. */
  kompast: { projectKey: string; teamId: string };
  /** This issue's (or comment's parent issue's) attachments, matched by filename. */
  attachments: AdfAttachment[];
  /** A JIRA key's number when the key belongs to the migrated JIRA project, else null. */
  issueKeyNumberFor: (jiraKey: string) => number | null;
}

export interface AdfBlocksStats {
  unknownNodes: Record<string, number>;
  mentions: number;
  issueMentions: number;
  /** Every media node converted (file and external, block and inline). */
  media: number;
  /** File media resolved to one of this issue's attachments (by __attachmentId or by filename). External media count here too: they link to a real URL. */
  mediaMatched: number;
  /** File media that matched no attachment; each became an "Attachment not found in JIRA" note. */
  mediaUnmatched: number;
}

// ── ADF input ───────────────────────────────────────────────────────────────

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: unknown;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
}

const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "blockquote",
  "codeBlock",
  "rule",
  "table",
  "panel",
  "expand",
  "nestedExpand",
  "mediaSingle",
  "mediaGroup",
  "media",
  "layoutSection",
  "layoutColumn",
]);

/** Inline ADF nodes that can turn up where a block is expected (a card on its own line, a bare mention). They're converted inline, not dropped. */
const INLINE_TYPES = new Set(["inlineCard", "mention", "emoji", "date", "status", "hardBreak", "mediaInline", "placeholder"]);

const PANEL_LABELS: Record<string, string> = { info: "Info", note: "Note", warning: "Warning", error: "Error", success: "Success", tip: "Tip" };

/** BlockNote's text palette, as names. Used for nearest-match text colours. */
const PALETTE: Record<string, [number, number, number]> = {
  red: [0xeb, 0x5d, 0x5d],
  orange: [0xf7, 0x8c, 0x2b],
  yellow: [0xe6, 0xb4, 0x00],
  green: [0x4c, 0xb3, 0x6e],
  blue: [0x3e, 0x8f, 0xdd],
  purple: [0x9b, 0x6c, 0xd9],
  pink: [0xe0, 0x6b, 0xb4],
  gray: [0x9b, 0x9b, 0x9b],
  brown: [0x9c, 0x6b, 0x4a],
};

function kids(node: AdfNode | undefined): AdfNode[] {
  return Array.isArray(node?.content) ? (node!.content as AdfNode[]).filter((n): n is AdfNode => !!n && typeof n === "object") : [];
}

function attrsOf(node: AdfNode): Record<string, unknown> {
  return node.attrs ?? {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/** The nearest BlockNote palette name for a hex colour, or null when the input isn't a colour. */
export function nearestTextColor(hex: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const rgb: [number, number, number] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  // Near-neutral colours are grey, whatever their lightness (plain RGB distance would call white "pink").
  if (Math.max(...rgb) - Math.min(...rgb) < 40) return "gray";
  let best = "gray";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [name, [r, g, b]] of Object.entries(PALETTE)) {
    const d = (rgb[0] - r) ** 2 + (rgb[1] - g) ** 2 + (rgb[2] - b) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = name;
    }
  }
  return best;
}

function isImageAttachment(att: AdfAttachment): boolean {
  if (att.mimeType) return att.mimeType.startsWith("image/");
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(att.filename);
}

// ── Converter ───────────────────────────────────────────────────────────────

interface Run {
  ctx: AdfBlockContext;
  stats: AdfBlocksStats;
}

/** A JIRA browse link to a key in the migrated project becomes an issue mention. Anything else stays a link. */
function issueMentionFor(href: string, run: Run): InlineNode & { type: "issueMention" } | null {
  const base = run.ctx.jiraBaseUrl?.replace(/\/+$/, "");
  if (!base || !href.startsWith(`${base}/browse/`)) return null;
  const match = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)(?=[/?#]|$)/.exec(href);
  if (!match) return null;
  const keySeq = run.ctx.issueKeyNumberFor(match[1]!);
  if (keySeq === null) return null;
  return {
    type: "issueMention",
    props: { issueId: "", projectKey: run.ctx.kompast.projectKey, keySeq: String(keySeq), title: "", teamId: run.ctx.kompast.teamId },
  };
}

function plainText(node: AdfNode): string {
  return adfToPlainText(node);
}

/** Marks → BlockNote styles, plus the link href if there is one. */
function stylesFrom(marks: AdfNode["marks"]): { styles: BlockNoteStyles; href: string | null } {
  const styles: BlockNoteStyles = {};
  let href: string | null = null;
  for (const mark of marks ?? []) {
    switch (mark?.type) {
      case "strong":
        styles.bold = true;
        break;
      case "em":
        styles.italic = true;
        break;
      case "underline":
        styles.underline = true;
        break;
      case "strike":
        styles.strike = true;
        break;
      case "code":
        styles.code = true;
        break;
      case "textColor": {
        const colour = nearestTextColor(str(mark.attrs?.color));
        if (colour) styles.textColor = colour;
        break;
      }
      case "link":
        href = str(mark.attrs?.href) || null;
        break;
      default:
        // subsup and the rest: no BlockNote equivalent, the text is kept.
        break;
    }
  }
  return { styles, href };
}

function dateText(value: unknown): string {
  const raw = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  const d = typeof raw === "number" || typeof raw === "string" ? new Date(raw) : null;
  if (!d || Number.isNaN(d.getTime())) return str(value);
  return d.toISOString().slice(0, 10);
}

/** Inline content of a run of ADF inline nodes (text, marks, mentions, cards, media, …). */
function inlinesOf(nodes: AdfNode[], run: Run): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of nodes) {
    out.push(...inlineOf(node, run));
  }
  return out;
}

function inlineOf(node: AdfNode, run: Run): InlineNode[] {
  const attrs = attrsOf(node);
  switch (node.type) {
    case "text": {
      const text = typeof node.text === "string" ? node.text : "";
      if (!text) return [];
      const { styles, href } = stylesFrom(node.marks);
      const styled: InlineNode = { type: "text", text, styles };
      if (!href) return [styled];
      const mention = issueMentionFor(href, run);
      if (mention) {
        run.stats.issueMentions++;
        return [mention];
      }
      return [{ type: "link", href, content: [styled] }];
    }
    case "hardBreak":
      return [{ type: "text", text: "\n", styles: {} }];
    case "emoji": {
      const text = str(attrs.text) || str(attrs.shortName);
      return text ? [{ type: "text", text, styles: {} }] : [];
    }
    case "mention": {
      const accountId = str(attrs.id);
      const resolved = accountId ? run.ctx.resolveUser(accountId) : null;
      const shown = str(attrs.text) || "@";
      run.stats.mentions++;
      if (resolved) return [{ type: "userMention", props: { userId: resolved.userId, name: resolved.name || shown.replace(/^@/, "") } }];
      return [{ type: "text", text: shown.startsWith("@") ? shown : `@${shown}`, styles: {} }];
    }
    case "date":
      return [{ type: "text", text: dateText(attrs.timestamp), styles: {} }];
    case "status":
      return [{ type: "text", text: str(attrs.text), styles: { bold: true } }];
    case "inlineCard":
    case "blockCard":
    case "embedCard": {
      const url = str(attrs.url);
      if (!url) return [];
      const mention = issueMentionFor(url, run);
      if (mention) {
        run.stats.issueMentions++;
        return [mention];
      }
      return [{ type: "link", href: url, content: [{ type: "text", text: url, styles: {} }] }];
    }
    case "mediaInline":
      return [mediaInlineOf(node, run)];
    case "placeholder":
      return [];
    default: {
      // An unknown inline node: its plain text is kept, and the type is counted.
      run.stats.unknownNodes[node.type ?? "(none)"] = (run.stats.unknownNodes[node.type ?? "(none)"] ?? 0) + 1;
      const text = plainText(node);
      return text ? [{ type: "text", text, styles: {} }] : [];
    }
  }
}

/** The attachment a file media name refers to: exact filename first, then case-insensitive. Undefined for an empty name. */
export function findAttachmentByName(attachments: AdfAttachment[], name: string): AdfAttachment | undefined {
  if (!name) return undefined;
  return attachments.find((a) => a.filename === name) ?? attachments.find((a) => a.filename.toLowerCase() === name.toLowerCase());
}

/** The name a file media node is matched by: its alt text, else its __fileName, else its media id. */
export function mediaNameOf(attrs: Record<string, unknown>): string {
  return str(attrs.alt) || str(attrs.__fileName) || str(attrs.id);
}

/**
 * The attachment a file media node refers to. attrs.__attachmentId (set by enrich.ts from JIRA's rendered
 * HTML, where the attachment id is known) wins; otherwise the node's name is matched against filenames.
 */
function attachmentForMedia(run: Run, attrs: Record<string, unknown>, name: string): AdfAttachment | undefined {
  const byId = str(attrs.__attachmentId);
  if (byId) {
    const att = run.ctx.attachments.find((a) => a.id === byId);
    if (att) return att;
  }
  return findAttachmentByName(run.ctx.attachments, name);
}

/** A media node sitting inside a line of text (a table cell, or mediaInline): a link to the attachment, or a note that it's missing. */
function mediaInlineOf(node: AdfNode, run: Run): InlineNode {
  run.stats.media++;
  const attrs = attrsOf(node);
  if (attrs.type === "external" && str(attrs.url)) {
    run.stats.mediaMatched++;
    return { type: "link", href: str(attrs.url), content: [{ type: "text", text: str(attrs.url), styles: {} }] };
  }
  const name = mediaNameOf(attrs);
  const att = attachmentForMedia(run, attrs, name);
  if (att) {
    run.stats.mediaMatched++;
    return { type: "link", href: att.content, content: [{ type: "text", text: att.filename, styles: {} }] };
  }
  run.stats.mediaUnmatched++;
  return { type: "text", text: `Attachment not found in JIRA: ${name}`, styles: { italic: true } };
}

/** Flattens block children into one inline run, for table cells: paragraphs and list items joined by line breaks. */
function flattenToInlines(nodes: AdfNode[], run: Run): InlineNode[] {
  const out: InlineNode[] = [];
  const pieces: InlineNode[][] = [];
  const add = (inl: InlineNode[]) => {
    if (inl.length) pieces.push(inl);
  };
  for (const node of nodes) {
    if (node.type === "paragraph" || node.type === "heading") add(inlinesOf(kids(node), run));
    else if (node.type === "bulletList" || node.type === "orderedList" || node.type === "taskList") {
      for (const item of kids(node)) add([{ type: "text", text: "• ", styles: {} }, ...flattenToInlines(kids(item), run)]);
    } else if (node.type === "blockquote" || node.type === "panel" || node.type === "expand" || node.type === "nestedExpand") {
      add(flattenToInlines(kids(node), run));
    } else if (node.type === "mediaSingle" || node.type === "mediaGroup") {
      for (const media of kids(node)) add([mediaInlineOf(media, run)]);
    } else if (node.type === "media") {
      add([mediaInlineOf(node, run)]);
    } else if (node.type === "rule") {
      continue;
    } else if (node.type === "codeBlock") {
      add([{ type: "text", text: plainText(node), styles: {} }]);
    } else if (node.type === "table") {
      for (const row of kids(node)) add(flattenToInlines(kids(row), run));
    } else if (node.type === "tableRow") {
      add(flattenToInlines(kids(node), run));
    } else if (node.type === "tableCell" || node.type === "tableHeader") {
      add(flattenToInlines(kids(node), run));
    } else {
      add(inlineOf(node, run));
    }
  }
  pieces.forEach((piece, i) => {
    if (i > 0) out.push({ type: "text", text: "\n", styles: {} });
    out.push(...piece);
  });
  return out;
}

function blockWith(type: string, props: Record<string, unknown>, content: InlineNode[] | undefined, children: BlockNode[] = []): BlockNode {
  return content === undefined ? { type, props, children } : { type, props, content, children };
}

function paragraphOf(inl: InlineNode[]): BlockNode {
  return blockWith("paragraph", {}, inl);
}

function quoteOf(inl: InlineNode[]): BlockNode {
  return blockWith("quote", {}, inl);
}

function listItemBlock(item: AdfNode, type: "bulletListItem" | "numberedListItem", run: Run): BlockNode {
  const nodes = kids(item);
  const [first, ...rest] = nodes;
  const head = first?.type === "paragraph" ? inlinesOf(kids(first), run) : [];
  const tail = (first?.type === "paragraph" ? rest : nodes).flatMap((n) => blocksOf(n, run));
  return blockWith(type, {}, head, tail);
}

function taskItemBlock(item: AdfNode, run: Run): BlockNode {
  const nodes = kids(item);
  const inline = nodes.filter((n) => !BLOCK_TYPES.has(n.type ?? ""));
  const blocks = nodes.filter((n) => BLOCK_TYPES.has(n.type ?? ""));
  const checked = str(attrsOf(item).state).toUpperCase() === "DONE";
  return blockWith("checkListItem", { checked }, inlinesOf(inline, run), blocks.flatMap((n) => blocksOf(n, run)));
}

function tableOf(node: AdfNode, run: Run): BlockNode {
  const rowNodes = kids(node);
  const rows: TableContentNode["rows"] = rowNodes.map((row) => ({ cells: kids(row).map((cell) => flattenToInlines(kids(cell), run)) }));
  const firstRow = rowNodes[0];
  const headerRow = !!firstRow && kids(firstRow).length > 0 && kids(firstRow).every((c) => c.type === "tableHeader");
  const content: TableContentNode = { type: "tableContent", columnWidths: [], rows };
  if (headerRow) content.headerRows = 1;
  return { type: "table", props: { textColor: "default" }, content, children: [] };
}

function mediaBlocks(node: AdfNode, run: Run): BlockNode[] {
  if (node.type === "mediaSingle" || node.type === "mediaGroup") {
    return kids(node).flatMap((child) => mediaBlocks(child, run));
  }
  run.stats.media++;
  const attrs = attrsOf(node);
  if (node.type === "media" && attrs.type === "external") {
    const url = str(attrs.url);
    if (url) {
      run.stats.mediaMatched++;
      return [{ type: "image", props: { url, name: url, caption: "" }, children: [] }];
    }
    run.stats.mediaUnmatched++;
    return [paragraphOf([{ type: "text", text: "Attachment not found in JIRA: external media", styles: { italic: true } }])];
  }
  const name = mediaNameOf(attrs);
  const att = attachmentForMedia(run, attrs, name);
  if (!att) {
    run.stats.mediaUnmatched++;
    return [paragraphOf([{ type: "text", text: `Attachment not found in JIRA: ${name}`, styles: { italic: true } }])];
  }
  run.stats.mediaMatched++;
  // The JIRA attachment's content URL goes in as-is. See the header comment for Phase 4.
  const props = { url: att.content, name: att.filename, caption: "" };
  return [{ type: isImageAttachment(att) ? "image" : "file", props, children: [] }];
}

/** One ADF block node → BlockNote blocks (usually one; lists, panels and media can give several). */
function blocksOf(node: AdfNode, run: Run): BlockNode[] {
  switch (node.type) {
    case "paragraph":
      return [paragraphOf(inlinesOf(kids(node), run))];
    case "heading": {
      const level = Math.min(Math.max(Number(attrsOf(node).level) || 1, 1), 3);
      return [blockWith("heading", { level }, inlinesOf(kids(node), run))];
    }
    case "bulletList":
      return kids(node).map((item) => listItemBlock(item, "bulletListItem", run));
    case "orderedList":
      return kids(node).map((item) => listItemBlock(item, "numberedListItem", run));
    case "taskList":
      return kids(node).map((item) => taskItemBlock(item, run));
    case "blockquote":
      return kids(node).flatMap((child) => (child.type === "paragraph" ? [quoteOf(inlinesOf(kids(child), run))] : blocksOf(child, run)));
    case "codeBlock": {
      const language = str(attrsOf(node).language);
      const text = plainText(node);
      return [blockWith("codeBlock", { language }, text ? [{ type: "text", text, styles: {} }] : [])];
    }
    case "rule":
      // BlockNote's divider: a horizontal rule, as JIRA shows it.
      return [{ type: "divider", props: {}, children: [] }];
    case "table":
      return [tableOf(node, run)];
    case "panel": {
      const label = PANEL_LABELS[str(attrsOf(node).panelType)] ?? "Panel";
      const out: BlockNode[] = [];
      let labelled = false;
      for (const child of kids(node)) {
        if (child.type === "paragraph") {
          const inl = inlinesOf(kids(child), run);
          if (!labelled) {
            inl.unshift({ type: "text", text: `${label}: `, styles: { bold: true } });
            labelled = true;
          }
          out.push(quoteOf(inl));
        } else {
          out.push(...blocksOf(child, run));
        }
      }
      if (!labelled) out.unshift(quoteOf([{ type: "text", text: `${label}:`, styles: { bold: true } }]));
      return out;
    }
    case "expand":
    case "nestedExpand": {
      const title = str(attrsOf(node).title);
      const out: BlockNode[] = [];
      if (title) out.push(paragraphOf([{ type: "text", text: title, styles: { bold: true } }]));
      for (const child of kids(node)) out.push(...blocksOf(child, run));
      return out;
    }
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return mediaBlocks(node, run);
    case "layoutSection":
    case "layoutColumn":
      return kids(node).flatMap((child) => blocksOf(child, run));
    case "text":
      return node.text ? [paragraphOf(inlineOf(node, run))] : [];
    case "blockCard":
    case "embedCard":
      // A card on its own line: a link (or an issue mention) in a paragraph of its own.
      return [paragraphOf(inlineOf(node, run))];
    default: {
      if (INLINE_TYPES.has(node.type ?? "")) return [paragraphOf(inlineOf(node, run))];
      // An unknown block node (or one that's really inline): its plain text stays, and the type is counted.
      const type = node.type ?? "(none)";
      run.stats.unknownNodes[type] = (run.stats.unknownNodes[type] ?? 0) + 1;
      const text = plainText(node);
      return text ? [paragraphOf([{ type: "text", text, styles: {} }])] : [];
    }
  }
}

function emptyStats(): AdfBlocksStats {
  return { unknownNodes: {}, mentions: 0, issueMentions: 0, media: 0, mediaMatched: 0, mediaUnmatched: 0 };
}

/**
 * Converts one ADF document (or a plain string) to BlockNote blocks. A string
 * body becomes one paragraph per line. Never throws: input it can't read falls
 * back to its plain text.
 */
export function adfToBlocks(adf: unknown, ctx: AdfBlockContext): { blocks: BlockNode[]; stats: AdfBlocksStats } {
  const run: Run = { ctx, stats: emptyStats() };
  try {
    if (adf == null) return { blocks: [], stats: run.stats };
    if (typeof adf === "string") {
      const blocks = adf
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => paragraphOf([{ type: "text", text: line, styles: {} }]));
      return { blocks, stats: run.stats };
    }
    if (typeof adf !== "object") return { blocks: [], stats: run.stats };

    const root = adf as AdfNode;
    const nodes = root.type === "doc" || root.type === undefined ? kids(root) : [root];
    const blocks = nodes.flatMap((node) => blocksOf(node, run));
    return { blocks, stats: run.stats };
  } catch {
    const text = adfToPlainText(adf);
    const blocks = text ? [paragraphOf([{ type: "text", text, styles: {} }])] : [];
    return { blocks, stats: run.stats };
  }
}
