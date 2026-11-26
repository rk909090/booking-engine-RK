import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { brand } from "@/config/brand";
import type { Locale } from "@/i18n/config";
import * as schema from "@/db/schema";
import { demoLogin } from "./demo-login";
import { deliverSetupLink } from "./outbox";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export type AuthSettings = {
  /** Public origin of the app, e.g. https://be.attarahospitality.com */
  baseURL: string;
  /** At least 32 random characters. Never commit it. */
  secret: string;
};

export const PASSWORD_MIN_LENGTH = 12;
/** Staff are local; their account links open the Indonesian pages. */
export const STAFF_LOCALE: Locale = "id";
export const SESSION_HOURS = 12;

/** Builds the auth instance. Separate from the server singleton so tests and scripts can pass their own database. */
export function createAuth(db: AnyDb, settings: AuthSettings) {
  return betterAuth({
    appName: brand.name,
    baseURL: settings.baseURL,
    secret: settings.secret,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.authUsers,
        session: schema.authSessions,
        account: schema.authAccounts,
        verification: schema.authVerifications,
        twoFactor: schema.authTwoFactors,
      },
    }),
    emailAndPassword: {
      enabled: true,
      // Staff accounts are created with `npm run staff:invite`, never by visitors.
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60 * 24,
      sendResetPassword: async ({ user, token }) => {
        const url = new URL(`/${STAFF_LOCALE}/ops/set-password`, settings.baseURL);
        url.searchParams.set("token", token);
        await deliverSetupLink({ email: user.email, url: url.toString() });
      },
    },
    session: {
      expiresIn: 60 * 60 * SESSION_HOURS,
      updateAge: 60 * 60,
      // Signed cookie that skips the session lookup for up to 5 minutes.
      // Trade-off: a revoked session can stay usable for that long.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    rateLimit: { enabled: true, window: 60, max: 30 },
    advanced: {
      // Hostinger's proxy passes the visitor's address in X-Forwarded-For.
      // Without it every visitor would share one rate-limit bucket.
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    plugins: [twoFactor({ issuer: brand.name }), demoLogin(db)],
  });
}

export type Auth = ReturnType<typeof createAuth>;
