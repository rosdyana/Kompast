import { BlockNoteSchema, defaultBlockSpecs, createBlockSpec } from "@blocknote/core";

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

  return BlockNoteSchema.create({
    blockSpecs: { ...defaultBlockSpecs, kompastView: kompastViewServerSpec() },
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
