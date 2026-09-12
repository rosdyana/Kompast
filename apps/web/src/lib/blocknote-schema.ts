import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, createBlockSpec, createInlineContentSpec } from "@blocknote/core";

/**
 * Shared block shape for the kompastView embed (a board's table view,
 * inline in a doc) — kept in its own module so the client editor
 * (Editor.tsx, full React rendering), the guest share export
 * (server-fns/share.ts), and version-restore decode
 * (server-fns/pages.ts) all parse the exact same Yjs structure. A
 * mismatched propSchema between client and server would silently corrupt
 * or drop the block when decoding a stored document.
 */
export const kompastViewBlockConfig = {
  type: "kompastView" as const,
  propSchema: {
    boardId: { default: "" as string },
    viewId: { default: "" as string },
    projectKey: { default: "" as string },
  },
  content: "none" as const,
};

/**
 * Inline @mention of another page. title/icon are denormalized into the
 * mention's own props at insert time (not looked up live) — simplest and
 * fastest to render, at the cost of a mention not updating if the target
 * page is later renamed. A doc mentioning a page the reader otherwise has
 * no access to just shows that page's title; unlike the kompastView
 * embed, there's no live data behind a mention to protect (see
 * blocknote-schema's kompastView notes for the embed's actual concern),
 * so no guest redaction is needed for this one.
 */
export const mentionInlineConfig = {
  type: "mention" as const,
  propSchema: {
    pageId: { default: "" as string },
    title: { default: "" as string },
    icon: { default: "" as string },
  },
  content: "none" as const,
};

/**
 * Inline chip left behind when a doc line is converted into a tracked
 * issue (see Editor.tsx's "create issue" slash command), or when an issue
 * is @mentioned from the issue detail page's description/comment editor
 * (see LiteEditor's SuggestionMenuController). issueId/projectKey/keySeq/
 * title/teamId are all denormalized at insert time — same "no live
 * lookup" reasoning as mentionInlineConfig above, and for the same
 * reason, no guest redaction is needed (see redactEmbedsForGuests): this
 * is a display chip, not a live data embed. teamId is needed to build
 * the issue detail route's link (`/issues/$teamId/$projectKey/
 * $issueKeySeq`) — defaults to "" for chips inserted before this field
 * existed; the render component falls back to "none" for those, same
 * sentinel the rest of the app uses for a teamless project.
 */
export const issueMentionInlineConfig = {
  type: "issueMention" as const,
  propSchema: {
    issueId: { default: "" as string },
    projectKey: { default: "" as string },
    keySeq: { default: "" as string },
    title: { default: "" as string },
    teamId: { default: "" as string },
  },
  content: "none" as const,
};

/**
 * Inline @mention of a person — userId/name denormalized at insert time,
 * same reasoning as mentionInlineConfig/issueMentionInlineConfig above
 * (simplest to render; doesn't live-update if the user is later renamed).
 * Used by the issue detail page's description/comment editors (LiteEditor)
 * only, not the docs editor. packages/core's extractMentionedUserIds reads
 * this exact shape to decide who to notify on a new comment/description —
 * keep the two in sync if this ever changes.
 */
export const userMentionInlineConfig = {
  type: "userMention" as const,
  propSchema: {
    userId: { default: "" as string },
    name: { default: "" as string },
  },
  content: "none" as const,
};

/**
 * Server-side only: lets yDocToBlocks (structural decode — never invokes
 * render/toExternalHTML at all) and blocksToFullHTML recognize the
 * kompastView block type without crashing or dropping it. `render` here
 * is a stub to satisfy createBlockSpec's type — do NOT rely on it for
 * safety. BlockNote's exporter attaches every prop as a `data-*` HTML
 * attribute on the block's wrapper element automatically, regardless of
 * what `render`/`toExternalHTML` return, so `boardId`/`viewId` would leak
 * into the output HTML even behind a "safe-looking" custom render — this
 * was caught by a real test (see __tests__/blocknote-schema.test.ts),
 * not assumed. The only safe way to keep an embed's data out of a guest
 * export is to never hand the block to blocksToFullHTML in the first
 * place — see redactEmbedsForGuests below, used by share.ts.
 */
export function createServerSchema() {
  const kompastViewServerSpec = createBlockSpec(kompastViewBlockConfig, {
    render: () => ({ dom: document.createElement("div") }),
  });
  const mentionServerSpec = createInlineContentSpec(mentionInlineConfig, {
    render: (inlineContent: any) => {
      const dom = document.createElement("span");
      dom.textContent = `@${inlineContent.props.title || "Tanpa judul"}`;
      return { dom };
    },
  });
  const issueMentionServerSpec = createInlineContentSpec(issueMentionInlineConfig, {
    render: (inlineContent: any) => {
      const dom = document.createElement("span");
      dom.textContent = `${inlineContent.props.projectKey}-${inlineContent.props.keySeq}`;
      return { dom };
    },
  });

  return BlockNoteSchema.create({
    blockSpecs: { ...defaultBlockSpecs, kompastView: kompastViewServerSpec() },
    inlineContentSpecs: { ...defaultInlineContentSpecs, mention: mentionServerSpec, issueMention: issueMentionServerSpec },
  });
}

/**
 * Replaces every kompastView block (recursively, including nested
 * children) with a plain placeholder paragraph before guest export —
 * see createServerSchema's docstring for why this, and not a "safe"
 * custom render, is what actually keeps boardId/viewId out of the HTML a
 * guest receives.
 */
export function redactEmbedsForGuests(blocks: any[]): any[] {
  return blocks.map((block) =>
    block.type === "kompastView"
      ? {
          type: "paragraph",
          content: [{ type: "text", text: "📊 Tabel Kanban — buka di Kompast untuk melihat", styles: {} }],
        }
      : { ...block, children: block.children ? redactEmbedsForGuests(block.children) : block.children },
  );
}
