import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { getInvitationStatusFn, acceptInvitationFn, rejectInvitationFn } from "@/lib/server-fns/invitations";
import { signInWithMicrosoft } from "@/lib/auth-client";

export const Route = createFileRoute("/invite/$invitationId")({
  loader: ({ params }) => getInvitationStatusFn({ data: params.invitationId }),
  component: InvitePage,
});

const STATUS_LABEL: Record<string, string> = { accepted: "diterima", rejected: "ditolak", canceled: "dibatalkan" };

function InvitePage() {
  const data = Route.useLoaderData();
  const params = Route.useParams();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (data.requiresLogin) {
    return (
      <div className="grid min-h-screen place-items-center bg-bg px-6">
        <div className="w-full max-w-[380px] rounded-xl border border-border bg-surface p-8 text-center">
          <h1 className="mb-2 text-xl font-semibold tracking-tight">Anda diundang ke Kompast</h1>
          <p className="mb-6 text-sm text-text-2">Masuk dengan akun kerja Anda untuk melihat dan menerima undangan ini.</p>
          <Button variant="primary" className="w-full" onClick={() => signInWithMicrosoft(`/invite/${params.invitationId}`)}>
            Lanjut dengan Microsoft
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
          <p className="text-sm text-text-2">Undangan ini sudah {STATUS_LABEL[invitation.status] ?? invitation.status}.</p>
        ) : !emailMatches ? (
          <p className="text-sm text-text-2">
            Undangan ini dikirim ke <strong>{invitation.email}</strong>, tapi Anda masuk sebagai <strong>{currentUserEmail}</strong>. Keluar dan masuk
            dengan akun yang benar untuk menerima undangan ini.
          </p>
        ) : (
          <>
            <h1 className="mb-2 text-xl font-semibold tracking-tight">Bergabung ke {invitation.organizationName}</h1>
            <p className="mb-6 text-sm text-text-2">
              Anda diundang sebagai <strong>{invitation.role}</strong>.
            </p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={accept} disabled={busy}>
                Terima
              </Button>
              <Button variant="outline" onClick={reject} disabled={busy}>
                Tolak
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
