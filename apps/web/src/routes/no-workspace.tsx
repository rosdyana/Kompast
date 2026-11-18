import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Inbox } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { useTranslation } from "@kompast/i18n";
import { authClient } from "@/lib/auth-client";
import { listMyPendingInvitationsFn } from "@/lib/server-fns/invitations";
import { AuthLayout } from "@/components/auth/AuthLayout";

/**
 * Signed in, but with no workspace membership yet (e.g. a new user who signed
 * in with Microsoft without using their invite link). Outside _app on purpose,
 * so the _app loader's own redirect here can't loop.
 */
export const Route = createFileRoute("/no-workspace")({
  loader: async () => {
    const data = await listMyPendingInvitationsFn();
    if (!data) throw redirect({ to: "/login" });
    return data;
  },
  component: NoWorkspacePage,
});

function NoWorkspacePage() {
  const { t } = useTranslation("auth");
  const { email, invitations } = Route.useLoaderData();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await authClient.signOut();
      await router.navigate({ to: "/login" });
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <AuthLayout>
      <span className="mb-5 grid h-11 w-11 place-items-center rounded-[12px] bg-accent-soft text-accent-text">
        <Inbox size={20} />
      </span>
      <h2 className="type-title">{t("noWorkspace.heading")}</h2>
      <p className="mt-2 type-body text-text-2">
        {t("noWorkspace.signedInAs")} <strong className="text-text">{email}</strong>
      </p>

      {invitations.length > 0 ? (
        <div className="mt-6">
          <p className="mb-2 text-[14px] font-medium">{t("noWorkspace.pendingHeading")}</p>
          <ul className="flex flex-col gap-2">
            {invitations.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-3 rounded-[10px] border border-border bg-surface px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium">{inv.organizationName}</p>
                  <p className="text-[12.5px] text-text-3">{t("noWorkspace.roleLabel", { role: inv.role ?? "member" })}</p>
                </div>
                <Link
                  to="/invite/$invitationId"
                  params={{ invitationId: inv.id }}
                  className="inline-flex h-8 flex-none items-center rounded-[6px] border border-border-2 bg-surface px-3 text-[14px] font-medium hover:bg-surface-2"
                >
                  {t("noWorkspace.openInvitation")}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-6 type-body text-text-2">{t("noWorkspace.notInvitedYet", { email })}</p>
      )}

      <Button variant="ghost" className="mt-8" onClick={signOut} disabled={signingOut}>
        {t("noWorkspace.signOut")}
      </Button>
    </AuthLayout>
  );
}
