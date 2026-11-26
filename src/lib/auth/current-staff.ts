import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/db/client";
import type { Locale } from "@/i18n/config";
import { getAuth } from "./server";
import { loadStaffProfile, type StaffProfile } from "./staff";

/**
 * The request's session and staff profile, read once per request (the
 * sidebar and the page both need it).
 */
const currentSession = cache(async (): Promise<{ signedIn: false } | { signedIn: true; profile: StaffProfile | null }> => {
  const requestHeaders = await headers();
  let session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) return { signedIn: false };

  // The session cookie cache can be up to 5 minutes old. Someone who has just
  // turned on 2FA would still look "not enrolled", so confirm against the
  // database before sending them back to the setup page.
  if (!session.user.twoFactorEnabled) {
    session = await getAuth().api.getSession({
      headers: requestHeaders,
      query: { disableCookieCache: true },
    });
    if (!session) return { signedIn: false };
  }
  return { signedIn: true, profile: await loadStaffProfile(getDb(), session.user) };
});

/**
 * Data access layer for the operations area. Reads the request's session,
 * so callers must render inside a <Suspense> boundary (Cache Components).
 *
 * - no session                  -> login page
 * - no active staff record      -> login page with ?error=no_staff
 * - 2FA not set up (unless allowed) -> security page to enroll
 */
export async function requireStaff(
  lang: Locale,
  options: { allowWithoutTwoFactor?: boolean } = {},
): Promise<StaffProfile> {
  const current = await currentSession();
  if (!current.signedIn) redirect(`/${lang}/ops/login`);
  const profile = current.profile;
  if (!profile) redirect(`/${lang}/ops/login?error=no_staff`);

  if (!profile.twoFactorEnabled && !options.allowWithoutTwoFactor) {
    redirect(`/${lang}/ops/security`);
  }
  return profile;
}
