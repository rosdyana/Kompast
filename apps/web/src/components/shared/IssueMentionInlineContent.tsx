import { Link } from "@tanstack/react-router";
import { createReactInlineContentSpec } from "@blocknote/react";
import { issueMentionInlineConfig } from "@/lib/blocknote-schema";

export const issueMentionInlineSpec = createReactInlineContentSpec(issueMentionInlineConfig, {
  render: ({ inlineContent }) => (
    <Link
      to="/issues/$teamId/$projectKey/$issueKeySeq"
      params={{ teamId: inlineContent.props.teamId || "none", projectKey: inlineContent.props.projectKey, issueKeySeq: inlineContent.props.keySeq }}
      className="rounded-[4px] bg-accent-soft px-1 py-px font-medium text-accent-text no-underline decoration-accent-text/40 hover:underline"
    >
      <span className="font-mono text-[0.88em]">{inlineContent.props.projectKey}-{inlineContent.props.keySeq}</span> {inlineContent.props.title}
    </Link>
  ),
});
