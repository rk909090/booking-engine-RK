import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { createAuth, type Auth } from "@/lib/auth/config";
import { inviteStaff } from "@/lib/auth/provision";
import { loadStaffProfile } from "@/lib/auth/staff";
import { createTestDb, type TestDb } from "../db/test-db";

const BASE = "http://localhost:3000";
const STRONG_PASSWORD = "correct-horse-battery-staple";

/** Minimal cookie jar so requests behave like one browser. */
class Browser {
  private cookies = new Map<string, string>();
  constructor(private readonly auth: Auth) {}

  async call(path: string, body?: unknown) {
    const headers = new Headers({ origin: BASE, "x-forwarded-for": "127.0.0.1" });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (this.cookies.size) {
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const response = await this.auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const [name, ...rest] = pair.split("=");
      const value = rest.join("=");
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim())) || value === "";
      if (expired) this.cookies.delete(name.trim());
      else this.cookies.set(name.trim(), value);
    }
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), written independently of Better Auth. */
function totp(base32Secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32Secret.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

let db: TestDb;
let auth: Auth;
let close: () => Promise<void>;
let setupToken: string;
let backupCodes: string[] = [];
let totpSecret = "";

beforeAll(async () => {
  const test = await createTestDb();
  db = test.db;
  close = () => test.client.close();
  await seedSampleData(db);
  auth = createAuth(db, { baseURL: BASE, secret: "test-secret-".repeat(4) });
});

afterAll(async () => {
  await close();
});

describe("staff authentication", () => {
  it("invites a staff member with a one-time password link", async () => {
    const result = await inviteStaff(auth, db, {
      email: "Manager@Example.com",
      fullName: "Made Manager",
      role: "branch_manager",
      propertySlugs: ["ubud"],
    });
    expect(result.created).toBe(true);
    const url = new URL(result.setupUrl);
    expect(url.pathname).toBe("/id/ops/set-password");
    setupToken = url.searchParams.get("token")!;
    expect(setupToken).toBeTruthy();

    const [staff] = await db.select().from(schema.staffMembers).where(eq(schema.staffMembers.id, result.staffId));
    expect(staff.email).toBe("manager@example.com");
    expect(staff.authUserId).toBe(result.authUserId);
  });

  it("rejects invites that are missing a property or use an unknown one", async () => {
    await expect(
      inviteStaff(auth, db, { email: "fo@example.com", fullName: "FO", role: "front_office", propertySlugs: [] }),
    ).rejects.toThrow(/needs at least one property/);
    await expect(
      inviteStaff(auth, db, { email: "fo@example.com", fullName: "FO", role: "front_office", propertySlugs: ["bali"] }),
    ).rejects.toThrow(/Unknown property/);
  });

  it("does not allow public sign-up", async () => {
    const browser = new Browser(auth);
    const res = await browser.call("/sign-up/email", {
      email: "stranger@example.com",
      password: STRONG_PASSWORD,
      name: "Stranger",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const [row] = await db.select().from(schema.authUsers).where(eq(schema.authUsers.email, "stranger@example.com"));
    expect(row).toBeUndefined();
  });

  it("cannot sign in before the password is set", async () => {
    const res = await new Browser(auth).call("/sign-in/email", {
      email: "manager@example.com",
      password: STRONG_PASSWORD,
    });
    expect(res.status).toBe(401);
  });

  it("enforces the minimum password length", async () => {
    const res = await new Browser(auth).call("/reset-password", { token: setupToken, newPassword: "short" });
    expect(res.status).toBe(400);
  });

  it("sets the password once with the link token", async () => {
    const browser = new Browser(auth);
    expect((await browser.call("/reset-password", { token: setupToken, newPassword: STRONG_PASSWORD })).status).toBe(200);
    expect((await browser.call("/reset-password", { token: setupToken, newPassword: STRONG_PASSWORD })).status).toBe(400);
  });

  it("signs in without 2FA, then enrolls an authenticator app", async () => {
    const browser = new Browser(auth);
    const signIn = await browser.call("/sign-in/email", { email: "manager@example.com", password: STRONG_PASSWORD });
    expect(signIn.status).toBe(200);
    expect(signIn.json.twoFactorRedirect).toBeFalsy();

    const session = await browser.call("/get-session");
    const before = await loadStaffProfile(db, session.json.user);
    expect(before?.twoFactorEnabled).toBe(false);

    const enable = await browser.call("/two-factor/enable", { password: STRONG_PASSWORD, method: "totp" });
    expect(enable.status).toBe(200);
    totpSecret = new URL(enable.json.totpURI).searchParams.get("secret")!;
    backupCodes = enable.json.backupCodes;
    expect(backupCodes.length).toBeGreaterThan(0);

    const wrong = await browser.call("/two-factor/verify-totp", { code: "000000" === totp(totpSecret) ? "111111" : "000000" });
    expect(wrong.status).toBeGreaterThanOrEqual(400);

    const verify = await browser.call("/two-factor/verify-totp", { code: totp(totpSecret) });
    expect(verify.status).toBe(200);

    const after = await browser.call("/get-session");
    expect(after.json.user.twoFactorEnabled).toBe(true);
  });

  it("requires the second factor on the next sign-in", async () => {
    const browser = new Browser(auth);
    const signIn = await browser.call("/sign-in/email", { email: "manager@example.com", password: STRONG_PASSWORD });
    expect(signIn.status).toBe(200);
    expect(signIn.json.twoFactorRedirect).toBe(true);
    expect((await browser.call("/get-session")).json).toBeNull();

    const badBackup = await browser.call("/two-factor/verify-backup-code", { code: "not-a-real-code" });
    expect(badBackup.status).toBeGreaterThanOrEqual(400);
    expect((await browser.call("/get-session")).json).toBeNull();

    const ok = await browser.call("/two-factor/verify-backup-code", { code: backupCodes[0] });
    expect(ok.status).toBe(200);

    const session = await browser.call("/get-session");
    const profile = await loadStaffProfile(db, session.json.user);
    expect(profile?.role).toBe("branch_manager");
    expect(profile?.twoFactorEnabled).toBe(true);
    expect(profile?.actor.propertyIds).toHaveLength(1);
  });

  it("re-inviting an existing account keeps the user and issues a new link", async () => {
    const again = await inviteStaff(auth, db, {
      email: "manager@example.com",
      fullName: "Made Manager",
      role: "branch_manager",
      propertySlugs: ["ubud", "canggu"],
    });
    expect(again.created).toBe(false);
    const access = await db.select().from(schema.staffPropertyAccess).where(eq(schema.staffPropertyAccess.staffId, again.staffId));
    expect(access).toHaveLength(2);
  });

  it("returns no staff profile for a deactivated staff member", async () => {
    await db.update(schema.staffMembers).set({ isActive: false }).where(eq(schema.staffMembers.email, "manager@example.com"));
    const [user] = await db.select().from(schema.authUsers).where(eq(schema.authUsers.email, "manager@example.com"));
    expect(await loadStaffProfile(db, user)).toBeNull();
  });
});
