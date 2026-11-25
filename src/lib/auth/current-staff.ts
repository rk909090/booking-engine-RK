import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import type { Locale } from "@/i18n/config";
import { getAuth } from "./server";
import { loadStaffProfile, type StaffProfile } from "./staff";

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
  const requestHeaders = await headers();
  let session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) redirect(`/${lang}/ops/login`);

  // The session cookie cache can be up to 5 minutes old. Someone who has just
  // turned on 2FA would still look "not enrolled", so confirm against the
  // database before sending them back to the setup page.
  if (!session.user.twoFactorEnabled && !options.allowWithoutTwoFactor) {
    session = await getAuth().api.getSession({
      headers: requestHeaders,
      query: { disableCookieCache: true },
    });
    if (!session) redirect(`/${lang}/ops/login`);
  }

  const profile = await loadStaffProfile(getDb(), session.user);
  if (!profile) redirect(`/${lang}/ops/login?error=no_staff`);

  if (!profile.twoFactorEnabled && !options.allowWithoutTwoFactor) {
    redirect(`/${lang}/ops/security`);
  }
  return profile;
}
