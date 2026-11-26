import { and, eq, inArray, like, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import type { Role } from "@/lib/authz/permissions";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/*
 * Sign-in switches for the whole group (decided with the owner, 26 Nov 2026),
 * changed by a real director on Settings › Sign-in & security:
 *
 * - demoLogin: the sign-in page shows one button per role that signs in to a
 *   demo account without a password, for presenting the system. Anyone who
 *   opens the sign-in page can use it, so it stays off except during a
 *   presentation. Turning it off ends every demo session at once.
 * - twoFactorRequired: staff must set up an authenticator app before using
 *   the operations area. Off until launch; accounts that already use an
 *   authenticator are still asked for a code.
 *
 * A missing row means the safe default: no demo sign-in, 2FA required.
 */

export type AccessSettings = { demoLogin: boolean; twoFactorRequired: boolean };
export type AccessKey = keyof AccessSettings;
export const ACCESS_DEFAULTS: AccessSettings = { demoLogin: false, twoFactorRequired: true };
const KEYS: Record<AccessKey, string> = { demoLogin: "demo_login", twoFactorRequired: "two_factor_required" };

/** The demo accounts the sign-in buttons use, one per role (branch manager, front office and housekeeping at Ubud). */
export const DEMO_LOGIN_EMAILS = {
  director: "demo-director@example.com",
  branch_manager: "demo-manager.ubud@example.com",
  front_office: "demo-fo.ubud@example.com",
  housekeeping: "demo-hk.ubud@example.com",
} as const satisfies Record<Role, string>;

/** Demo staff (npm run demo:seed) all use demo-…@example.com. */
export function isDemoEmail(email: string): boolean {
  return /^demo-[^@\s]+@example\.com$/i.test(email);
}

export async function readAccessSettings(db: AnyDb): Promise<AccessSettings> {
  const rows = await db.select().from(schema.appSettings).where(inArray(schema.appSettings.key, Object.values(KEYS)));
  const value = (key: AccessKey) => {
    const row = rows.find((r) => r.key === KEYS[key]);
    return typeof row?.value === "boolean" ? row.value : ACCESS_DEFAULTS[key];
  };
  return { demoLogin: value("demoLogin"), twoFactorRequired: value("twoFactorRequired") };
}

export type AccessResult = { ok: true } | { ok: false; error: "demo_account" };

/**
 * Saves one switch. Demo accounts cannot change them (they would otherwise
 * keep their own way in open). Turning demo sign-in off signs every demo
 * account out.
 */
export async function setAccessSetting(db: AnyDb, input: { key: AccessKey; value: boolean; actor: { staffId: string; isDemo: boolean } }): Promise<AccessResult> {
  if (input.actor.isDemo) return { ok: false, error: "demo_account" };
  const before = (await readAccessSettings(db))[input.key];
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.appSettings)
      .values({ key: KEYS[input.key], value: input.value, updatedBy: input.actor.staffId })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: input.value, updatedBy: input.actor.staffId, updatedAt: new Date() } });
    if (input.key === "demoLogin" && !input.value) {
      await tx.delete(schema.authSessions).where(inArray(schema.authSessions.userId, tx.select({ id: schema.authUsers.id }).from(schema.authUsers).where(like(schema.authUsers.email, "demo-%@example.com"))));
    }
    if (before !== input.value) {
      await tx.insert(schema.auditEvents).values({ actorType: "staff", actorId: input.actor.staffId, entityType: "app_setting", entityId: KEYS[input.key], action: "settings.access_changed", before: { value: before }, after: { value: input.value }, occurredAt: new Date() });
    }
  });
  return { ok: true };
}

/**
 * What the operations area does with a signed-in staff member: let them in,
 * send a demo account away once demo sign-in is off, or send them to set up
 * an authenticator while 2FA is required.
 */
export function staffGate(
  profile: { isDemo: boolean; twoFactorEnabled: boolean },
  settings: AccessSettings,
  options: { allowWithoutTwoFactor?: boolean } = {},
): "ok" | "demo_off" | "enroll" {
  if (profile.isDemo && !settings.demoLogin) return "demo_off";
  if (settings.twoFactorRequired && !profile.twoFactorEnabled && !profile.isDemo && !options.allowWithoutTwoFactor) return "enroll";
  return "ok";
}

export type DemoLoginResult = { ok: true; authUserId: string } | { ok: false; error: "off" | "invalid" | "missing" };

/** The sign-in account behind a demo button, when demo sign-in is on. */
export async function findDemoLogin(db: AnyDb, role: unknown): Promise<DemoLoginResult> {
  if (!(await readAccessSettings(db)).demoLogin) return { ok: false, error: "off" };
  if (typeof role !== "string" || !Object.hasOwn(DEMO_LOGIN_EMAILS, role)) return { ok: false, error: "invalid" };
  const email = DEMO_LOGIN_EMAILS[role as Role];
  const [row] = await db
    .select({ authUserId: schema.staffMembers.authUserId })
    .from(schema.staffMembers)
    .where(and(eq(schema.staffMembers.email, email), eq(schema.staffMembers.role, role as Role), eq(schema.staffMembers.isActive, true), sql`${schema.staffMembers.authUserId} IS NOT NULL`));
  return row?.authUserId ? { ok: true, authUserId: row.authUserId } : { ok: false, error: "missing" };
}
