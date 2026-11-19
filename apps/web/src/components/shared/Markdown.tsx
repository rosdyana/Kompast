import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";

/**
 * Renders model/user Markdown as React elements (never innerHTML). react-markdown drops unsafe URLs such as
 * `javascript:` by default. Styled with the repo's Tailwind tokens, since there is no typography plugin.
 *
 * The first block's top margin and the last block's bottom margin are reset on the wrapper, so the rendered
 * content sits flush inside whatever bubble or panel contains it.
 */
const components: Components = {
  p: ({ node: _node, className, ...props }) => <p className={cn("my-2 leading-[1.7]", className)} {...props} />,
  h1: ({ node: _node, className, ...props }) => <h1 className={cn("mb-2 mt-4 text-[18px] font-semibold leading-snug text-text", className)} {...props} />,
  h2: ({ node: _node, className, ...props }) => <h2 className={cn("mb-2 mt-4 text-[16.5px] font-semibold leading-snug text-text", className)} {...props} />,
  h3: ({ node: _node, className, ...props }) => <h3 className={cn("mb-1.5 mt-3 text-[15.5px] font-semibold leading-snug text-text", className)} {...props} />,
  h4: ({ node: _node, className, ...props }) => <h4 className={cn("mb-1.5 mt-3 text-[15px] font-semibold leading-snug text-text-2", className)} {...props} />,
  ul: ({ node: _node, className, ...props }) => <ul className={cn("my-2 list-disc space-y-1 pl-5", className)} {...props} />,
  ol: ({ node: _node, className, ...props }) => <ol className={cn("my-2 list-decimal space-y-1 pl-5", className)} {...props} />,
  li: ({ node: _node, className, ...props }) => <li className={cn("pl-0.5 text-text", className)} {...props} />,
  // react-markdown v10 has no `inline` flag, so every <code> is styled as inline; a <pre> neutralises its child.
  code: ({ node: _node, className, ...props }) => <code className={cn("rounded bg-surface-2 px-1 py-px font-mono text-[13.5px]", className)} {...props} />,
  pre: ({ node: _node, ...props }) => (
    <pre
      className="my-2 overflow-x-auto rounded-[8px] bg-surface-2 p-3 font-mono text-[13px] leading-relaxed text-text [&>code]:rounded-none [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[13px]"
      {...props}
    />
  ),
  blockquote: ({ node: _node, className, ...props }) => <blockquote className={cn("my-2 border-l-2 border-border-2 pl-3 text-text-2", className)} {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[13.5px]" {...props} />
    </div>
  ),
  th: ({ node: _node, className, ...props }) => <th className={cn("border border-border bg-surface-2 px-2.5 py-1.5 text-left font-semibold text-text", className)} {...props} />,
  td: ({ node: _node, className, ...props }) => <td className={cn("border border-border px-2.5 py-1.5 align-top text-text-2", className)} {...props} />,
  hr: ({ node: _node, className, ...props }) => <hr className={cn("my-4 border-border", className)} {...props} />,
  a: ({ node: _node, href, className, ...props }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) => {
    const external = typeof href === "string" && /^https?:\/\//i.test(href);
    return (
      <a
        href={href}
        className={cn("break-words text-accent-text hover:underline", className)}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        {...props}
      />
    );
  },
};

export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("min-w-0 break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
