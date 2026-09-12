import { createReactInlineContentSpec } from "@blocknote/react";
import { userMentionInlineConfig } from "@/lib/blocknote-schema";

export const userMentionInlineSpec = createReactInlineContentSpec(userMentionInlineConfig, {
  render: ({ inlineContent }) => (
    <span className="rounded bg-accent-soft px-1 py-0.5 font-medium text-accent">@{inlineContent.props.name}</span>
  ),
});
