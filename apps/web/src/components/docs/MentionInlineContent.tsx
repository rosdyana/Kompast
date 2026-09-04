import { Link } from "@tanstack/react-router";
import { createReactInlineContentSpec } from "@blocknote/react";
import { mentionInlineConfig } from "@/lib/blocknote-schema";

export const mentionInlineSpec = createReactInlineContentSpec(mentionInlineConfig, {
  render: ({ inlineContent }) => (
    <Link
      to="/docs/$pageId"
      params={{ pageId: inlineContent.props.pageId }}
      className="rounded bg-accent-soft px-1 py-0.5 text-accent no-underline hover:underline"
    >
      {inlineContent.props.icon || "▤"} {inlineContent.props.title || "Tanpa judul"}
    </Link>
  ),
});
