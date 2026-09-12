import { Link } from "@tanstack/react-router";
import { createReactInlineContentSpec } from "@blocknote/react";
import { issueMentionInlineConfig } from "@/lib/blocknote-schema";

export const issueMentionInlineSpec = createReactInlineContentSpec(issueMentionInlineConfig, {
  render: ({ inlineContent }) => (
    <Link
      to="/issues/$teamId/$projectKey/$issueKeySeq"
      params={{ teamId: inlineContent.props.teamId || "none", projectKey: inlineContent.props.projectKey, issueKeySeq: inlineContent.props.keySeq }}
      className="rounded bg-accent-soft px-1 py-0.5 text-accent no-underline hover:underline"
    >
      {inlineContent.props.projectKey}-{inlineContent.props.keySeq} {inlineContent.props.title}
    </Link>
  ),
});
