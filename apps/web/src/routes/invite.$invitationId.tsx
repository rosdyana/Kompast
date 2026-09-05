import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { useTranslation } from "@kompast/i18n";
import { getInvitationStatusFn, acceptInvitationFn, rejectInvitationFn } from "@/lib/server-fns/invitations";
import { signInWithMicrosoft } from "@/lib/auth-client";

export const Route = createFileRoute("/invite/$invitationId")({
  loader: ({ params }) => getInvitationStatusFn({ data: params.invitationId }),
  component: InvitePage,
});

function InvitePage() {
  const { t } = useTranslation("auth");
  const data = Route.useLoaderData();
  const params = Route.useParams();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const STATUS_LABEL: Record<string, string> = {
    accepted: t("statusAccepted"),
    rejected: t("statusRejected"),
    canceled: t("statusCanceled"),
  };

  if (data.requiresLogin) {
    return (
      <div className="grid min-h-screen place-items-center bg-bg px-6">
        <div className="w-full max-w-[380px] rounded-xl border border-border bg-surface p-8 text-center">
          <h1 className="mb-2 text-xl font-semibold tracking-tight">{t("invitedHeading")}</h1>
          <p className="mb-6 text-sm text-text-2">{t("invitedSubtext")}</p>
          <Button variant="primary" className="w-full" onClick={() => signInWithMicrosoft(`/invite/${params.invitationId}`)}>
            {t("continueWithMicrosoft")}
          </Button>
        </div>
      </div>
    );
  }

  const { invitation, currentUserEmail, emailMatches } = data;

  async function accept() {
    setBusy(true);
    try {
      await acceptInvitationFn({ data: invitation.id });
      await router.navigate({ to: "/" });
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    try {
      await rejectInvitationFn({ data: invitation.id });
      await router.navigate({ to: "/login" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-bg px-6">
      <div className="w-full max-w-[420px] rounded-xl border border-border bg-surface p-8">
        {invitation.status !== "pending" ? (
          <p className="text-sm text-text-2">{t("alreadyProcessed", { status: STATUS_LABEL[invitation.status] ?? invitation.status })}</p>
        ) : !emailMatches ? (
          <p className="text-sm text-text-2">
            {t("emailMismatchPart1")}
            <strong>{invitation.email}</strong>
            {t("emailMismatchPart2")}
            <strong>{currentUserEmail}</strong>
            {t("emailMismatchPart3")}
          </p>
        ) : (
          <>
            <h1 className="mb-2 text-xl font-semibold tracking-tight">{t("joinHeading", { org: invitation.organizationName })}</h1>
            <p className="mb-6 text-sm text-text-2">
              {t("invitedAsPart1")}
              <strong>{invitation.role}</strong>
              {t("invitedAsPart2")}
            </p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={accept} disabled={busy}>
                {t("accept")}
              </Button>
              <Button variant="outline" onClick={reject} disabled={busy}>
                {t("decline")}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
