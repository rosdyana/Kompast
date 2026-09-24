import { createReactInlineContentSpec } from "@blocknote/react";
import { userMentionInlineConfig } from "@/lib/blocknote-schema";

export const userMentionInlineSpec = createReactInlineContentSpec(userMentionInlineConfig, {
  render: ({ inlineContent }) => (
    <span className="rounded-[4px] bg-accent-soft px-1 py-px font-medium text-accent-text">@{inlineContent.props.name}</span>
  ),
});
