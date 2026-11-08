import { JSDOM } from "jsdom";
import createDOMPurify, { type DOMPurify } from "dompurify";

/**
 * Server-side sanitizer for the guest share page's HTML (produced by
 * BlockNote's blocksToFullHTML from stored Yjs content and rendered by
 * `s.$token.tsx` through dangerouslySetInnerHTML).
 *
 * Page content is user-authored, and a guest link is reachable by anyone
 * with the URL, so the markup must be inert before it leaves the server.
 * Kept as a pure function (no tanstack/db imports) so the test can call it
 * directly.
 *
 * The jsdom window is created once, lazily: jsdom is externalized in the
 * Nitro build (see apps/web/vite.config.ts), so it has to be resolved at
 * runtime from node_modules, and building a window per request would be
 * needlessly expensive.
 */

const FORBIDDEN_TAGS = [
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "meta",
  "link",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "option",
  "noscript",
  "template",
];

const FORBIDDEN_ATTR = ["srcdoc", "formaction"];

// Links may only point at web or mail destinations. Relative and other
// schemes are dropped from anchors. Other URI-bearing attributes (images,
// media) keep DOMPurify's default URI policy, which already rejects
// javascript: and friends.
const SAFE_LINK_HREF = /^(https?:|mailto:)/i;

let purify: DOMPurify | undefined;

function getPurify(): DOMPurify {
  if (purify) return purify;

  const window = new JSDOM("").window;
  const instance = createDOMPurify(window as unknown as Window & typeof globalThis);

  instance.addHook("uponSanitizeAttribute", (node, data) => {
    if (node.nodeName === "A" && data.attrName === "href") {
      const value = (data.attrValue ?? "").replace(/[\u0000- \u007f-\u009f]/g, "");
      if (!SAFE_LINK_HREF.test(value)) {
        data.keepAttr = false;
      }
    }
  });

  instance.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName !== "A") return;
    if (node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
    } else {
      node.removeAttribute("target");
    }
    node.setAttribute("rel", "noopener noreferrer");
  });

  purify = instance;
  return instance;
}

export function sanitizeShareHtml(html: string): string {
  if (!html) return "";
  return getPurify().sanitize(html, {
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTR,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    // Data attributes are how BlockNote marks block types and levels
    // (data-content-type, data-level, data-node-type); keep them.
    ALLOW_DATA_ATTR: true,
  });
}
