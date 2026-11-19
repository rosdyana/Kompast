// Client-only. Imports BlockNote, which must not reach server-only code (see
// the jsdom/Nitro gotcha in docs/ENGINEERING-NOTES.md). Only import this from
// client components.
import { BlockNoteEditor, type Block, type PartialBlock } from "@blocknote/core";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from "@kompast/i18n";
import { richTextSchema, normalizeToBlocks } from "@/components/shared/RichTextView";
import { streamAiCompletion } from "@/lib/ai-stream-client";

/** The language name sent to the model, per UI locale. */
export const LOCALE_LANGUAGE: Record<SupportedLocale, string> = {
  en: "English",
  id: "Indonesian",
  "zh-Hant": "Traditional Chinese (Taiwan)",
};

/** Maps an i18next language code onto a supported locale, falling back to the default. */
export function localeOf(language: string | undefined): SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(language ?? "") ? (language as SupportedLocale) : DEFAULT_LOCALE;
}

function createHeadlessEditor() {
  return BlockNoteEditor.create({ schema: richTextSchema });
}

let headless: ReturnType<typeof createHeadlessEditor> | null = null;

/** Created on first use only, so importing this module does no editor work. */
function headlessEditor() {
  if (!headless) headless = createHeadlessEditor();
  return headless;
}

/**
 * Mentions carry no text of their own in markdown, so they would be dropped by
 * the export. Replace them with plain runs (`@Name`, `KEY-n`) first. Walks the
 * whole tree because mentions also sit inside link content and table cells. A
 * malformed mention with missing props is removed rather than emitted empty.
 */
function replaceMentionsWithText(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(replaceMentionsWithText).filter((n) => n !== null);
  }
  if (node && typeof node === "object") {
    const obj = node as { type?: unknown; props?: Record<string, unknown> } & Record<string, unknown>;
    if (obj.type === "userMention") {
      const name = obj.props?.name;
      return typeof name === "string" && name ? { type: "text", text: `@${name}`, styles: {} } : null;
    }
    if (obj.type === "issueMention") {
      const projectKey = obj.props?.projectKey;
      const keySeq = obj.props?.keySeq;
      return typeof projectKey === "string" && projectKey && typeof keySeq === "string" && keySeq
        ? { type: "text", text: `${projectKey}-${keySeq}`, styles: {} }
        : null;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) out[key] = replaceMentionsWithText(value);
    return out;
  }
  return node;
}

/** Stored rich-text (legacy `{text}` or Block[]) to markdown. Empty string when there is nothing to export. */
export function blocksToMarkdown(json: unknown): string {
  const blocks = normalizeToBlocks(json);
  if (!blocks || blocks.length === 0) return "";
  const plain = replaceMentionsWithText(blocks) as PartialBlock[];
  return headlessEditor().blocksToMarkdownLossy(plain as Parameters<BlockNoteEditor["blocksToMarkdownLossy"]>[0]);
}

/** Markdown from the model back to BlockNote blocks. */
export function markdownToBlocks(markdown: string): Block[] {
  return headlessEditor().tryParseMarkdownToBlocks(markdown) as unknown as Block[];
}

/** Streams a translation and returns the full accumulated text. */
export async function translateText(text: string, targetLanguage: string): Promise<string> {
  let out = "";
  await streamAiCompletion({ feature: "doc", action: "translate", text, targetLanguage }, (delta) => {
    out += delta;
  });
  return out.trim();
}

/**
 * Translates stored rich-text content. Returns [] without calling the AI when
 * there is no text. Throws when the model returns nothing for non-empty input,
 * so the caller shows an error rather than a blank view.
 */
export async function translateContent(json: unknown, targetLanguage: string): Promise<Block[]> {
  const markdown = blocksToMarkdown(json);
  if (!markdown.trim()) return [];
  const translated = await translateText(markdown, targetLanguage);
  if (!translated) throw new Error("the AI returned an empty translation");
  return markdownToBlocks(translated);
}
