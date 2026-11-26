import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { DEMO_LOGIN_EMAILS, findDemoLogin, isDemoEmail, readAccessSettings, setAccessSetting, staffGate } from "@/domain/app-settings";
import { createAuth, type Auth } from "@/lib/auth/config";
import { loadStaffProfile } from "@/lib/auth/staff";
import { createTestDb, type TestDb } from "../db/test-db";

const BASE = "http://localhost:3000";

let db: TestDb;
let auth: Auth;
let close: () => Promise<void>;
let realDirector: string;

/** One request to the auth handler, like a browser on the sign-in page. */
async function call(path: string, body?: unknown, cookie?: string) {
  const headers = new Headers({ origin: BASE, "x-forwarded-for": "127.0.0.1" });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const response = await auth.handler(new Request(`${BASE}/api/auth${path}`, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const cookies = response.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("="));
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, cookie: cookies.join("; ") };
}

beforeAll(async () => {
  const test = await createTestDb();
  db = test.db;
  close = () => test.client.close();
  await seedSampleData(db);
  auth = createAuth(db, { baseURL: BASE, secret: "test-secret-".repeat(4) });
  // The demo accounts as npm run demo:logins leaves them: staff linked to a sign-in user without a password.
  for (const [role, email] of Object.entries(DEMO_LOGIN_EMAILS)) {
    const authId = `demo-${role}`;
    await db.insert(schema.authUsers).values({ id: authId, name: role, email, emailVerified: true, twoFactorEnabled: false });
    await db.insert(schema.staffMembers).values({ email, fullName: role, role: role as "director", authUserId: authId });
  }
  await db.insert(schema.authUsers).values({ id: "real-director", name: "Real Director", email: "director@attara.test", emailVerified: true, twoFactorEnabled: true });
  const [real] = await db.insert(schema.staffMembers).values({ email: "director@attara.test", fullName: "Real Director", role: "director", authUserId: "real-director" }).returning();
  realDirector = real.id;
});
afterAll(async () => close());

describe("sign-in switches", () => {
  it("default to no demo sign-in and 2FA required", async () => {
    expect(await readAccessSettings(db)).toEqual({ demoLogin: false, twoFactorRequired: true });
  });

  it("recognise demo accounts by their address", () => {
    expect(isDemoEmail("demo-fo.ubud@example.com")).toBe(true);
    expect(isDemoEmail("DEMO-director@EXAMPLE.com")).toBe(true);
    expect(isDemoEmail("demo@example.com")).toBe(false);
    expect(isDemoEmail("demo-x@example.com.evil.test")).toBe(false);
    expect(isDemoEmail("director@attara.test")).toBe(false);
  });

  it("cannot be changed by a demo account", async () => {
    const [demo] = await db.select().from(schema.staffMembers).where(eq(schema.staffMembers.email, DEMO_LOGIN_EMAILS.director));
    expect(await setAccessSetting(db, { key: "twoFactorRequired", value: false, actor: { staffId: demo.id, isDemo: true } })).toEqual({ ok: false, error: "demo_account" });
    expect((await readAccessSettings(db)).twoFactorRequired).toBe(true);
  });

  it("decide who gets in", () => {
    const real = { isDemo: false, twoFactorEnabled: false };
    const demo = { isDemo: true, twoFactorEnabled: false };
    expect(staffGate(real, { demoLogin: false, twoFactorRequired: true })).toBe("enroll");
    expect(staffGate(real, { demoLogin: false, twoFactorRequired: true }, { allowWithoutTwoFactor: true })).toBe("ok");
    expect(staffGate(real, { demoLogin: false, twoFactorRequired: false })).toBe("ok");
    expect(staffGate({ ...real, twoFactorEnabled: true }, { demoLogin: false, twoFactorRequired: true })).toBe("ok");
    expect(staffGate(demo, { demoLogin: false, twoFactorRequired: false })).toBe("demo_off");
    expect(staffGate(demo, { demoLogin: true, twoFactorRequired: true })).toBe("ok");
  });
});

describe("demo sign-in buttons", () => {
  it("refuse while demo sign-in is off", async () => {
    expect(await findDemoLogin(db, "director")).toEqual({ ok: false, error: "off" });
    const res = await call("/demo-login", { role: "director" });
    expect(res.status).toBe(403);
    expect(res.cookie).toBe("");
  });

  it("sign in to the role's demo account while on, and only to a demo account", async () => {
    await setAccessSetting(db, { key: "demoLogin", value: true, actor: { staffId: realDirector, isDemo: false } });
    expect((await call("/demo-login", { role: "owner" })).status).toBe(403);
    expect((await call("/demo-login", {})).status).toBe(403);
    expect((await call("/demo-login", { role: "__proto__" })).status).toBe(403);

    for (const role of Object.keys(DEMO_LOGIN_EMAILS)) {
      const res = await call("/demo-login", { role });
      expect(res.status).toBe(200);
      const session = await call("/get-session", undefined, res.cookie);
      expect(session.json.user.email).toBe(DEMO_LOGIN_EMAILS[role as keyof typeof DEMO_LOGIN_EMAILS]);
      const profile = await loadStaffProfile(db, session.json.user);
      expect(profile?.role).toBe(role);
      expect(profile?.isDemo).toBe(true);
    }
  });

  it("refuse a demo account that was deactivated", async () => {
    await db.update(schema.staffMembers).set({ isActive: false }).where(eq(schema.staffMembers.email, DEMO_LOGIN_EMAILS.housekeeping));
    expect((await call("/demo-login", { role: "housekeeping" })).status).toBe(403);
    await db.update(schema.staffMembers).set({ isActive: true }).where(eq(schema.staffMembers.email, DEMO_LOGIN_EMAILS.housekeeping));
  });

  it("sign every demo account out when switched off, and leave real sessions alone", async () => {
    await db.insert(schema.authSessions).values({ id: "real-session", token: "real-token", userId: "real-director", expiresAt: new Date(Date.now() + 3_600_000) });
    const res = await call("/demo-login", { role: "front_office" });
    expect((await call("/get-session", undefined, res.cookie)).json?.user.email).toBe(DEMO_LOGIN_EMAILS.front_office);

    await setAccessSetting(db, { key: "demoLogin", value: false, actor: { staffId: realDirector, isDemo: false } });
    const sessions = await db.select({ userId: schema.authSessions.userId }).from(schema.authSessions);
    expect(sessions.map((s) => s.userId)).toEqual(["real-director"]);
    expect((await call("/demo-login", { role: "front_office" })).status).toBe(403);
    // Logged with what it was before.
    const trail = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "settings.access_changed"));
    expect(trail.map((e) => [e.entityId, e.before, e.after])).toEqual([
      ["demo_login", { value: false }, { value: true }],
      ["demo_login", { value: true }, { value: false }],
    ]);
  });
});
