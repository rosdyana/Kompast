import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [organizationClient()],
});

/**
 * `genericOAuth`/`microsoftEntraId` (apps/web/src/lib/auth.ts) register the
 * tenant's Entra app as an ordinary OAuthProvider under the hood — the same
 * shape a native `socialProviders` entry implements — so it is started the
 * same way as any social sign-in, via `signIn.social`, not a separate
 * generic-oauth client method (none exists; there is no
 * `better-auth/plugins/generic-oauth` client export).
 */
export function signInWithMicrosoft(callbackURL = "/") {
  return authClient.signIn.social({
    provider: "microsoft-entra-id",
    callbackURL,
  });
}
