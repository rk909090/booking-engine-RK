"use client";

import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";

/** Browser-side auth calls. Same origin as the app, so no baseURL is needed. */
export const authClient = createAuthClient({
  plugins: [twoFactorClient()],
});

/**
 * Full page load after sign-in, 2FA or sign-out. A client-side push could
 * reuse a router-cached response from before the change (for example an old
 * "redirect to 2FA setup"), so auth transitions always reload from the server.
 */
export function navigateAfterAuthChange(path: string) {
  window.location.assign(path);
}

export type AuthErrorKind = "invalidCredentials" | "tooManyAttempts" | "invalidCode" | "generic";

/** Maps Better Auth error responses to message keys in the dictionaries. */
export function authErrorKind(error: { status?: number; code?: string } | null | undefined): AuthErrorKind {
  if (!error) return "generic";
  if (error.status === 429) return "tooManyAttempts";
  if (error.code?.includes("OTP") || error.code?.includes("CODE") || error.code?.includes("TOTP")) {
    return "invalidCode";
  }
  if (error.status === 401) return "invalidCredentials";
  return "generic";
}
