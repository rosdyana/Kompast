import { createCodeBlockSpec } from "@blocknote/core";
import { debounce, isMermaidLanguage, renderMermaidSvg } from "@/lib/mermaid-render";

/**
 * BlockNote's default codeBlock, with a live Mermaid preview rendered under
 * the source when `language` is "mermaid". The stored block is an ordinary
 * codeBlock (the server schema in packages/editor keeps the default spec), so
 * export, share and version history all see plain code.
 *
 * The preview is a non-editable child of the block wrapper, outside contentDOM,
 * so the node view must ignore mutations inside it. Otherwise ProseMirror
 * redraws the whole node each time the SVG is inserted.
 */

const base = createCodeBlockSpec();

const RENDER_DEBOUNCE_MS = 400;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's render hooks are loosely typed
type AnyRender = any;

export const mermaidCodeBlockSpec = {
  ...base,
  implementation: {
    ...base.implementation,
    render(this: unknown, block: AnyRender, editor: AnyRender): AnyRender {
      const r = (base.implementation.render as AnyRender).call(this, block, editor);
      // Only the live node view gets a preview. BlockNote also calls render for
      // HTML serialization ("dom"), where mermaid must not run on detached nodes.
      const renderType = (this as { renderType?: string } | undefined)?.renderType;
      if (renderType !== "nodeView" || !isMermaidLanguage(block.props.language) || !r.contentDOM) return r;

      const preview = document.createElement("div");
      preview.contentEditable = "false";
      preview.className = "kp-mermaid-preview";
      const svgHost = document.createElement("div");
      const errorLine = document.createElement("div");
      errorLine.className = "kp-mermaid-error";
      errorLine.hidden = true;
      preview.append(svgHost, errorLine);
      r.dom.appendChild(preview);

      const contentDOM = r.contentDOM as HTMLElement;
      let destroyed = false;
      // Sequence number so a slow earlier render can't overwrite a newer result.
      let seq = 0;

      const update = async () => {
        const mine = ++seq;
        const result = await renderMermaidSvg(contentDOM.textContent ?? "");
        if (destroyed || mine !== seq) return;
        if ("svg" in result) {
          // Keep the last good SVG on a syntax error; only a clean result replaces it.
          svgHost.innerHTML = result.svg;
          errorLine.hidden = true;
          errorLine.textContent = "";
        } else {
          errorLine.hidden = false;
          errorLine.textContent = result.error;
        }
      };

      const debounced = debounce(() => {
        void update();
      }, RENDER_DEBOUNCE_MS);

      const observer = new MutationObserver(() => debounced.call());
      observer.observe(contentDOM, { characterData: true, childList: true, subtree: true });

      void update();

      const baseIgnore: ((m: MutationRecord | { type: "selection"; target: Node }) => boolean) | undefined = r.ignoreMutation;
      return {
        ...r,
        ignoreMutation: (m: MutationRecord | { type: "selection"; target: Node }) => {
          if (m.type !== "selection" && (m.target === preview || preview.contains(m.target as Node))) return true;
          return baseIgnore ? baseIgnore(m) : false;
        },
        destroy: () => {
          destroyed = true;
          observer.disconnect();
          debounced.cancel();
          r.destroy?.();
        },
      };
    },
  },
} as unknown as typeof base;
