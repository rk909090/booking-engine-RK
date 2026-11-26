import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { permissionOverrides, resetRolePermissions, resetStaffTwoFactor, saveRolePermissions, setStaffActive, updateStaffMember } from "@/domain/staff-admin";
import { actions, defaultAllows, isLocked, permissionsFor, roles } from "@/lib/authz/permissions";
import { createTestDb, type TestDb } from "./test-db";

let db: TestDb;
let close: () => Promise<void>;
let ubud: string;
let canggu: string;
let director: string;
let manager: string;
let housekeeper: string;
const as = (id: string) => ({ type: "staff" as const, id });

async function staff(email: string, role: "director" | "branch_manager" | "housekeeping", propertyIds: string[], authUserId?: string) {
  const [s] = await db.insert(schema.staffMembers).values({ email, fullName: email.split("@")[0], role, authUserId }).returning();
  if (propertyIds.length) await db.insert(schema.staffPropertyAccess).values(propertyIds.map((propertyId) => ({ staffId: s.id, propertyId })));
  return s.id;
}

beforeAll(async () => {
  const test = await createTestDb();
  db = test.db;
  close = () => test.client.close();
  await seedSampleData(db);
  const props = await db.select().from(schema.properties);
  ubud = props.find((p) => p.slug === "ubud")!.id;
  canggu = props.find((p) => p.slug === "canggu")!.id;
  await db.insert(schema.authUsers).values({ id: "auth-hk", name: "hk", email: "hk@example.com", twoFactorEnabled: true });
  director = await staff("dir@example.com", "director", []);
  manager = await staff("bm@example.com", "branch_manager", [ubud]);
  housekeeper = await staff("hk@example.com", "housekeeping", [ubud], "auth-hk");
});
afterAll(async () => close());

describe("staff administration", () => {
  it("changes name, role and properties, and logs it", async () => {
    expect(await updateStaffMember(db, { staffId: manager, fullName: "  Made   Wirawan ", role: "branch_manager", propertyIds: [ubud, canggu], actor: as(director) })).toEqual({ ok: true });
    const [m] = await db.select().from(schema.staffMembers).where(eq(schema.staffMembers.id, manager));
    expect(m.fullName).toBe("Made Wirawan");
    const access = await db.select().from(schema.staffPropertyAccess).where(eq(schema.staffPropertyAccess.staffId, manager));
    expect(access.map((a) => a.propertyId).sort()).toEqual([ubud, canggu].sort());
    const [log] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "staff.updated"));
    expect(log.entityId).toBe(manager);
  });

  it("requires a property for every role but director, and drops them for directors", async () => {
    expect(await updateStaffMember(db, { staffId: housekeeper, fullName: "hk", role: "housekeeping", propertyIds: [], actor: as(director) })).toEqual({ ok: false, error: "needs_property" });
    expect(await updateStaffMember(db, { staffId: housekeeper, fullName: "hk", role: "front_office", propertyIds: ["00000000-0000-4000-8000-000000000000"], actor: as(director) })).toEqual({ ok: false, error: "invalid" });
    expect(await updateStaffMember(db, { staffId: manager, fullName: "Made Wirawan", role: "director", propertyIds: [ubud], actor: as(director) })).toEqual({ ok: true });
    expect(await db.select().from(schema.staffPropertyAccess).where(eq(schema.staffPropertyAccess.staffId, manager))).toHaveLength(0);
  });

  it("keeps people from changing their own role and the last director from going", async () => {
    expect(await updateStaffMember(db, { staffId: director, fullName: "dir", role: "branch_manager", propertyIds: [ubud], actor: as(director) })).toEqual({ ok: false, error: "self" });
    // Two directors now (the manager was promoted): one may step down, not both.
    expect(await updateStaffMember(db, { staffId: manager, fullName: "Made Wirawan", role: "branch_manager", propertyIds: [ubud], actor: as(director) })).toEqual({ ok: true });
    expect(await updateStaffMember(db, { staffId: director, fullName: "dir", role: "branch_manager", propertyIds: [ubud], actor: as(manager) })).toEqual({ ok: false, error: "last_director" });
    expect(await setStaffActive(db, { staffId: director, active: false, actor: as(manager) })).toEqual({ ok: false, error: "last_director" });
    expect(await setStaffActive(db, { staffId: director, active: false, actor: as(director) })).toEqual({ ok: false, error: "self" });
  });

  it("signs a deactivated person out and can bring them back", async () => {
    await db.insert(schema.authSessions).values({ id: "s1", token: "t1", userId: "auth-hk", expiresAt: new Date(Date.now() + 3_600_000) });
    expect(await setStaffActive(db, { staffId: housekeeper, active: false, actor: as(director) })).toEqual({ ok: true });
    expect(await db.select().from(schema.authSessions).where(eq(schema.authSessions.userId, "auth-hk"))).toHaveLength(0);
    expect(await setStaffActive(db, { staffId: housekeeper, active: true, actor: as(director) })).toEqual({ ok: true });
    const [hk] = await db.select().from(schema.staffMembers).where(eq(schema.staffMembers.id, housekeeper));
    expect(hk.isActive).toBe(true);
  });

  it("resets someone else's two-factor setup, not your own", async () => {
    await db.insert(schema.authTwoFactors).values({ id: "tf1", secret: "x", backupCodes: "y", userId: "auth-hk" });
    expect(await resetStaffTwoFactor(db, { staffId: housekeeper, actor: as(director) })).toEqual({ ok: true });
    expect(await db.select().from(schema.authTwoFactors).where(eq(schema.authTwoFactors.userId, "auth-hk"))).toHaveLength(0);
    const [u] = await db.select().from(schema.authUsers).where(eq(schema.authUsers.id, "auth-hk"));
    expect(u.twoFactorEnabled).toBe(false);
    expect(await resetStaffTwoFactor(db, { staffId: director, actor: as(director) })).toEqual({ ok: false, error: "not_found" });
  });
});

describe("role permissions", () => {
  const defaults = (): Array<{ role: string; action: string }> => roles.flatMap((role) => actions.filter((a) => defaultAllows(role, a)).map((action) => ({ role, action })));

  it("stores only the cells that differ from the defaults, never locked ones", async () => {
    const granted = defaults()
      .filter((g) => !(g.role === "front_office" && g.action === "reservation.create"))
      .concat([{ role: "housekeeping", action: "guest.view" }, { role: "housekeeping", action: "users.manage" }, { role: "director", action: "nonsense.action" }]);
    const saved = await saveRolePermissions(db, { granted, actor: as(director) });
    expect(saved).toEqual({ ok: true, changed: 2 });
    const rows = (await permissionOverrides(db)).map((r) => `${r.role}|${r.action}|${r.allowed}`).sort();
    expect(rows).toEqual(["front_office|reservation.create|false", "housekeeping|guest.view|true"]);
    const overrides = await permissionOverrides(db);
    expect(permissionsFor("housekeeping", overrides)).toContain("guest.view");
    expect(permissionsFor("housekeeping", overrides)).not.toContain("users.manage");
    expect(permissionsFor("front_office", overrides)).not.toContain("reservation.create");
    // Saving the same matrix again changes nothing.
    expect(await saveRolePermissions(db, { granted, actor: as(director) })).toEqual({ ok: true, changed: 0 });
  });

  it("keeps the locked cells whatever is saved", async () => {
    await saveRolePermissions(db, { granted: [], actor: as(director) });
    const overrides = await permissionOverrides(db);
    for (const role of roles) {
      for (const action of actions.filter((a) => isLocked(role, a))) expect(permissionsFor(role, overrides).includes(action)).toBe(defaultAllows(role, action));
    }
    expect(permissionsFor("director", overrides)).toEqual(expect.arrayContaining(["users.manage", "roles.manage", "settings.manage", "dashboard.view"]));
  });

  it("goes back to the defaults", async () => {
    const reset = await resetRolePermissions(db, { actor: as(director) });
    expect(reset.removed).toBeGreaterThan(0);
    expect(await permissionOverrides(db)).toHaveLength(0);
  });
});
