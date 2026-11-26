import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "@/db/schema";
import { findDemoLogin } from "@/domain/app-settings";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * POST /api/auth/demo-login { role }: signs in to that role's demo account
 * without a password, only while a director has demo sign-in switched on
 * (domain/app-settings.ts). Demo accounts have no password, so this button
 * is their only way in.
 */
export function demoLogin(db: AnyDb) {
  return {
    id: "demo-login",
    endpoints: {
      demoLogin: createAuthEndpoint("/demo-login", { method: "POST" }, async (ctx) => {
        const role = (ctx.body as { role?: unknown } | undefined)?.role;
        const found = await findDemoLogin(db, role);
        if (!found.ok) throw new APIError("FORBIDDEN", { message: `demo_login_${found.error}` });
        const user = await ctx.context.internalAdapter.findUserById(found.authUserId);
        if (!user) throw new APIError("FORBIDDEN", { message: "demo_login_missing" });
        const session = await ctx.context.internalAdapter.createSession(user.id);
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ ok: true });
      }),
    },
  } satisfies BetterAuthPlugin;
}
