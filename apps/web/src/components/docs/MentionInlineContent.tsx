import { Link } from "@tanstack/react-router";
import { createReactInlineContentSpec } from "@blocknote/react";
import { useTranslation } from "@kompast/i18n";
import { mentionInlineConfig } from "@/lib/blocknote-schema";
import { PageIcon } from "./DocsTree";

/** Notion-style page mention: icon + underlined title, no pill. */
export const mentionInlineSpec = createReactInlineContentSpec(mentionInlineConfig, {
  render: ({ inlineContent }) => {
    const { t } = useTranslation("docs");
    return (
      <Link
        to="/docs/$pageId"
        params={{ pageId: inlineContent.props.pageId }}
        data-kp-mention=""
        className="inline-flex items-baseline gap-1 rounded-[4px] px-0.5 align-baseline text-text no-underline hover:bg-surface-3"
      >
        <PageIcon icon={inlineContent.props.icon || null} size={15} className="self-center" />
        <span className="font-medium underline decoration-border-2 underline-offset-[3px]">{inlineContent.props.title || t("untitled")}</span>
      </Link>
    );
  },
});
