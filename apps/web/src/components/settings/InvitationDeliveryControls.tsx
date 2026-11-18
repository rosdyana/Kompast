import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Copy, RotateCw } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { Badge } from "@kompast/ui/Badge";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation } from "@kompast/i18n";

/** Mirrors EmailDelivery from @kompast/core (getEmailDelivery). */
export interface InvitationDelivery {
  state: "sent" | "failing" | "failed" | "queued";
  error: string | null;
  attempts: number;
}

/** Delivery status for one invitation's email. The error (if any) is the worker's real vendor error, shown as a tooltip. */
export function InvitationDeliveryBadge({ delivery }: { delivery: InvitationDelivery | null }) {
  const { t } = useTranslation("settings");
  if (!delivery) return <Badge tone="neutral">{t("invitations.deliveryNoEmail")}</Badge>;
  if (delivery.state === "sent") return <Badge tone="green">{t("invitations.deliverySent")}</Badge>;
  if (delivery.state === "failed") {
    return (
      <Badge tone="danger" title={delivery.error ?? undefined}>
        {t("invitations.deliveryFailed")}
      </Badge>
    );
  }
  if (delivery.state === "failing") {
    return (
      <Badge tone="amber" title={delivery.error ?? undefined}>
        {t("invitations.deliveryFailing")}
      </Badge>
    );
  }
  return <Badge tone="neutral">{t("invitations.deliveryQueued")}</Badge>;
}

/**
 * Copy-link and resend buttons for a pending invitation. Copy works even when
 * mail is broken, so an admin can still share the accept link by hand.
 * `onResend` runs the caller's resend server fn; the route is invalidated afterwards.
 */
export function InvitationRowActions({ inviteUrl, onResend }: { inviteUrl: string; onResend: () => Promise<unknown> }) {
  const { t } = useTranslation("settings");
  const toast = useToast();
  const router = useRouter();
  const [resending, setResending] = useState(false);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast.show({ title: t("invitations.linkCopied") });
    } catch {
      toast.show({ tone: "error", title: t("invitations.linkCopyFailed") });
    }
  }

  async function resend() {
    setResending(true);
    try {
      await onResend();
      toast.show({ title: t("invitations.resent") });
      await router.invalidate();
    } catch (err) {
      toast.show({ tone: "error", title: t("invitations.resendFailed"), description: err instanceof Error ? err.message : undefined });
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="flex flex-none items-center gap-1">
      <Button variant="ghost" size="xs" onClick={copyLink} title={t("invitations.copyLink")} aria-label={t("invitations.copyLink")}>
        <Copy size={13} />
        {t("invitations.copyLink")}
      </Button>
      <Button variant="ghost" size="xs" onClick={resend} disabled={resending} title={t("invitations.resend")} aria-label={t("invitations.resend")}>
        <RotateCw size={13} />
        {resending ? t("invitations.resendingEllipsis") : t("invitations.resend")}
      </Button>
    </div>
  );
}
