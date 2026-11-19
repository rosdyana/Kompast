/**
 * Browser-only Mermaid rendering for diagram code blocks.
 *
 * `mermaid` is loaded exclusively through the dynamic `import("mermaid")`
 * below, so it becomes a lazily fetched client chunk and is never evaluated
 * during SSR. Do not add a static import of it anywhere in apps/web.
 *
 * Nothing in this module touches `document` at import time (vitest runs in
 * a node environment), and the DOM is only read inside the functions.
 */

let mermaidReady: Promise<typeof import("mermaid").default> | undefined;
let initializedTheme: "dark" | "neutral" | undefined;
let renderCounter = 0;

export function isMermaidLanguage(lang: string | undefined | null): boolean {
  return (lang ?? "").trim().toLowerCase() === "mermaid";
}

/** The app marks dark mode with `data-theme="dark"` on <html> (see packages/ui/src/theme.tsx). */
function currentMermaidTheme(): "dark" | "neutral" {
  if (typeof document === "undefined") return "neutral";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "neutral";
}

async function loadMermaid(): Promise<typeof import("mermaid").default> {
  mermaidReady ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidReady;
  const theme = currentMermaidTheme();
  if (initializedTheme !== theme) {
    // suppressErrorRendering: a parse error throws instead of drawing mermaid's
    // own error graphic into document.body, which would otherwise be left behind
    // while the user is still typing an invalid diagram.
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme });
    initializedTheme = theme;
  }
  return mermaid;
}

export async function renderMermaidSvg(source: string): Promise<{ svg: string } | { error: string }> {
  if (!source.trim()) return { svg: "" };
  const id = `kp-mermaid-${renderCounter++}`;
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(id, source);
    return { svg };
  } catch (err) {
    if (typeof document !== "undefined") document.getElementById(`d${id}`)?.remove();
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic over any argument list
export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    call(...args: Parameters<T>) {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        fn(...args);
      }, ms);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
