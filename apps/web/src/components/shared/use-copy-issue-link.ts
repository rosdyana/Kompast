import { useToast } from "@kompast/ui/Toast";
import { useTranslation } from "@kompast/i18n";
import { issuePath } from "@/lib/issue-link";

/** "Copy link" for an issue anywhere in the app (board card, table row, backlog row, doc embed), with the same toast as the issue page. */
export function useCopyIssueLink() {
  const toast = useToast();
  const { t } = useTranslation("common");
  return async (ref: { teamId: string | null; projectKey: string; keySeq: number | string }) => {
    try {
      await navigator.clipboard.writeText(window.location.origin + issuePath(ref));
      toast.show({ title: t("linkCopied"), description: `${ref.projectKey}-${ref.keySeq}` });
    } catch {
      toast.show({ tone: "error", title: t("somethingWentWrong") });
    }
  };
}
