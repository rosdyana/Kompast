import type { NotionIcon, NotionPropertyValue, NotionRichText } from "./types";

const HEX32 = /^[0-9a-f]{32}$/;

/**
 * A Notion id as the dashed lowercase UUID, whatever form it came in
 * (dashed or not, any case). Null when the string isn't an id. Every id the
 * importer compares (search results, mentions, block parents) goes through
 * this, so one page can't show up under two spellings.
 */
export function normalizeNotionId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hex = raw.replace(/-/g, "").toLowerCase();
  if (!HEX32.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The Notion page id a notion.so URL points at (its slug's trailing id, or `?p=<id>`), or null for any other host. */
export function notionIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)notion\.so$/i.test(parsed.hostname)) return null;
  const p = parsed.searchParams.get("p");
  const fromParam = normalizeNotionId(p);
  if (fromParam) return fromParam;
  const path = parsed.pathname.replace(/-/g, "").toLowerCase();
  const matches = [...path.matchAll(/(?<![0-9a-f])([0-9a-f]{32})(?![0-9a-f])/g)];
  const last = matches.at(-1);
  return last ? normalizeNotionId(last[1]) : null;
}

/** Plain text of a rich text array. */
export function richTextPlain(items: NotionRichText[] | null | undefined): string {
  if (!Array.isArray(items)) return "";
  return items.map((item) => item.plain_text ?? item.text?.content ?? "").join("");
}

/** A page's title: the value of its "title" property. */
export function titleOfProperties(properties: Record<string, NotionPropertyValue> | null | undefined): string {
  if (!properties) return "";
  for (const prop of Object.values(properties)) {
    if (prop.type === "title") return richTextPlain(prop.title as NotionRichText[] | undefined);
  }
  return "";
}

/**
 * The title a Kompast page gets for a Notion object: trimmed, and "Untitled
 * database" / "Untitled" when Notion has none (a row is a page, so it is "Untitled").
 */
export function displayTitle(kind: "page" | "database" | "row", raw: string | null | undefined): string {
  const title = (raw ?? "").trim();
  if (title) return title;
  return kind === "database" ? "Untitled database" : "Untitled";
}

/** The emoji of an icon, or null for any other kind of icon (external, file, custom emoji). */
export function emojiOf(icon: NotionIcon | null | undefined): string | null {
  return icon?.type === "emoji" && typeof icon.emoji === "string" && icon.emoji.length > 0 ? icon.emoji : null;
}
