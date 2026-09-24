import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { MailCheck } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { useTranslation } from "@kompast/i18n";
import { getInvitationStatusFn, acceptInvitationFn, rejectInvitationFn } from "@/lib/server-fns/invitations";
import { signInWithMicrosoft } from "@/lib/auth-client";
import { AuthLayout, MicrosoftGlyph } from "@/components/auth/AuthLayout";

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
  const [error, setError] = useState<string | null>(null);

  const STATUS_LABEL: Record<string, string> = {
    accepted: t("statusAccepted"),
    rejected: t("statusRejected"),
    canceled: t("statusCanceled"),
  };

  const icon = (
    <span className="mb-5 grid h-11 w-11 place-items-center rounded-[12px] bg-accent-soft text-accent-text">
      <MailCheck size={20} />
    </span>
  );

  if (data.requiresLogin) {
    return (
      <AuthLayout>
        {icon}
        <h2 className="type-title">{t("invitedHeading")}</h2>
        <p className="mt-2 type-body text-text-2">{t("invitedSubtext")}</p>
        <Button variant="dark" size="lg" className="mt-7 w-full" onClick={() => signInWithMicrosoft(`/invite/${params.invitationId}`)}>
          <MicrosoftGlyph />
          {t("continueWithMicrosoft")}
        </Button>
      </AuthLayout>
    );
  }

  const { invitation, currentUserEmail, emailMatches } = data;

  async function run(fn: () => Promise<unknown>, to: "/" | "/login") {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await router.navigate({ to });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      {icon}
      {invitation.status !== "pending" ? (
        <>
          <p className="type-body text-text-2">{t("alreadyProcessed", { status: STATUS_LABEL[invitation.status] ?? invitation.status })}</p>
          <Link to="/" className="mt-5 inline-flex h-8 items-center rounded-[6px] border border-border-2 bg-surface px-3 text-[14px] font-medium hover:bg-surface-2">
            {t("signInAgain")}
          </Link>
        </>
      ) : !emailMatches ? (
        <p className="type-body text-text-2">
          {t("emailMismatchPart1")}
          <strong className="text-text">{invitation.email}</strong>
          {t("emailMismatchPart2")}
          <strong className="text-text">{currentUserEmail}</strong>
          {t("emailMismatchPart3")}
        </p>
      ) : (
        <>
          <h2 className="type-title">{t("joinHeading", { org: invitation.organizationName })}</h2>
          <p className="mt-2 type-body text-text-2">
            {t("invitedAsPart1")}
            <strong className="text-text">{invitation.role}</strong>
            {t("invitedAsPart2")}
          </p>
          {error && <p className="mt-4 rounded-[6px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
          <div className="mt-6 flex gap-2">
            <Button variant="primary" onClick={() => run(() => acceptInvitationFn({ data: invitation.id }), "/")} disabled={busy}>
              {t("accept")}
            </Button>
            <Button variant="ghost" onClick={() => run(() => rejectInvitationFn({ data: invitation.id }), "/login")} disabled={busy}>
              {t("decline")}
            </Button>
          </div>
        </>
      )}
    </AuthLayout>
  );
}
