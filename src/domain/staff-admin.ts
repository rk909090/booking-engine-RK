import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { actions, defaultAllows, isLocked, roles, type Action, type Role } from "@/lib/authz/permissions";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Actor = { type: "staff"; id: string };

/*
 * Administration of staff accounts and of what each role may do (decided
 * with the owner, 26 Nov 2026): only directors manage users and roles. The
 * guard rails below keep the group from locking itself out: nobody changes
 * their own role or deactivates themselves, and the last active director
 * stays a director. Every change is written to the audit log.
 */

export type StaffAdminError = "not_found" | "invalid" | "self" | "last_director" | "needs_property";
export type StaffAdminResult = { ok: true } | { ok: false; error: StaffAdminError };

async function otherActiveDirectors(db: AnyDb, staffId: string) {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.staffMembers)
    .where(and(eq(schema.staffMembers.role, "director"), eq(schema.staffMembers.isActive, true), ne(schema.staffMembers.id, staffId)));
  return n;
}

async function audit(db: AnyDb, actor: Actor, staffId: string, action: string, before: object | null, after: object) {
  await db.insert(schema.auditEvents).values({ actorType: "staff", actorId: actor.id, entityType: "staff_member", entityId: staffId, action, before, after, occurredAt: new Date() });
}

/** Ends every session of a staff member's sign-in account (they must sign in again). */
async function endSessions(db: AnyDb, authUserId: string | null) {
  if (authUserId) await db.delete(schema.authSessions).where(eq(schema.authSessions.userId, authUserId));
}

/** Name, role and properties. A non-director needs at least one property; directors see all of them. */
export async function updateStaffMember(
  db: AnyDb,
  input: { staffId: string; fullName: string; role: string; propertyIds: string[]; actor: Actor },
): Promise<StaffAdminResult> {
  const fullName = input.fullName.trim().replace(/\s+/g, " ").slice(0, 120);
  if (fullName.length < 2 || !(roles as readonly string[]).includes(input.role)) return { ok: false, error: "invalid" };
  const role = input.role as Role;
  const [member] = await db.select().from(schema.staffMembers).where(eq(schema.staffMembers.id, input.staffId));
  if (!member) return { ok: false, error: "not_found" };
  if (member.id === input.actor.id && member.role !== role) return { ok: false, error: "self" };
  if (member.role === "director" && role !== "director" && member.isActive && (await otherActiveDirectors(db, member.id)) === 0) return { ok: false, error: "last_director" };
  const wanted = [...new Set(input.propertyIds)];
  const known = wanted.length ? await db.select({ id: schema.properties.id }).from(schema.properties).where(inArray(schema.properties.id, wanted)) : [];
  if (known.length !== wanted.length) return { ok: false, error: "invalid" };
  const propertyIds = role === "director" ? [] : wanted;
  if (role !== "director" && propertyIds.length === 0) return { ok: false, error: "needs_property" };
  const before = await db.select({ id: schema.staffPropertyAccess.propertyId }).from(schema.staffPropertyAccess).where(eq(schema.staffPropertyAccess.staffId, member.id));
  await db.transaction(async (tx) => {
    await tx.update(schema.staffMembers).set({ fullName, role, updatedAt: new Date() }).where(eq(schema.staffMembers.id, member.id));
    await tx.delete(schema.staffPropertyAccess).where(eq(schema.staffPropertyAccess.staffId, member.id));
    if (propertyIds.length) await tx.insert(schema.staffPropertyAccess).values(propertyIds.map((propertyId) => ({ staffId: member.id, propertyId })));
    if (member.authUserId && fullName !== member.fullName) await tx.update(schema.authUsers).set({ name: fullName, updatedAt: new Date() }).where(eq(schema.authUsers.id, member.authUserId));
  });
  await audit(db, input.actor, member.id, "staff.updated", { fullName: member.fullName, role: member.role, properties: before.map((b) => b.id) }, { fullName, role, properties: propertyIds });
  return { ok: true };
}

/** Deactivating signs the person out at once and keeps their history; they can be reactivated later. */
export async function setStaffActive(db: AnyDb, input: { staffId: string; active: boolean; actor: Actor }): Promise<StaffAdminResult> {
  const [member] = await db.select().from(schema.staffMembers).where(eq(schema.staffMembers.id, input.staffId));
  if (!member) return { ok: false, error: "not_found" };
  if (member.isActive === input.active) return { ok: true };
  if (!input.active) {
    if (member.id === input.actor.id) return { ok: false, error: "self" };
    if (member.role === "director" && (await otherActiveDirectors(db, member.id)) === 0) return { ok: false, error: "last_director" };
  }
  await db.update(schema.staffMembers).set({ isActive: input.active, updatedAt: new Date() }).where(eq(schema.staffMembers.id, member.id));
  if (!input.active) await endSessions(db, member.authUserId);
  await audit(db, input.actor, member.id, input.active ? "staff.reactivated" : "staff.deactivated", null, {});
  return { ok: true };
}

/** For a lost phone: removes the authenticator so the person sets it up again at the next sign-in. */
export async function resetStaffTwoFactor(db: AnyDb, input: { staffId: string; actor: Actor }): Promise<StaffAdminResult> {
  const [member] = await db.select().from(schema.staffMembers).where(eq(schema.staffMembers.id, input.staffId));
  if (!member || !member.authUserId) return { ok: false, error: "not_found" };
  // Your own authenticator is changed on the account security page.
  if (member.id === input.actor.id) return { ok: false, error: "self" };
  await db.transaction(async (tx) => {
    await tx.delete(schema.authTwoFactors).where(eq(schema.authTwoFactors.userId, member.authUserId!));
    await tx.update(schema.authUsers).set({ twoFactorEnabled: false, updatedAt: new Date() }).where(eq(schema.authUsers.id, member.authUserId!));
  });
  await endSessions(db, member.authUserId);
  await audit(db, input.actor, member.id, "staff.two_factor_reset", null, {});
  return { ok: true };
}

/** The saved changes to the default permission matrix. */
export async function permissionOverrides(db: AnyDb) {
  return db.select({ role: schema.rolePermissions.role, action: schema.rolePermissions.action, allowed: schema.rolePermissions.allowed }).from(schema.rolePermissions);
}

/**
 * Saves the whole matrix as ticked on the roles screen. Only cells that differ
 * from the default are stored; locked cells and unknown actions are ignored.
 * Returns how many cells changed.
 */
export async function saveRolePermissions(db: AnyDb, input: { granted: Array<{ role: string; action: string }>; actor: Actor }): Promise<{ ok: true; changed: number }> {
  const granted = new Set(input.granted.map((g) => `${g.role}|${g.action}`));
  const current = await permissionOverrides(db);
  const effective = (role: Role, action: Action) => current.find((o) => o.role === role && o.action === action)?.allowed ?? defaultAllows(role, action);
  const rows: Array<{ role: Role; action: Action; allowed: boolean }> = [];
  const changes: Array<{ role: Role; action: Action; allowed: boolean }> = [];
  for (const role of roles) {
    for (const action of actions) {
      if (isLocked(role, action)) continue;
      const allowed = granted.has(`${role}|${action}`);
      if (allowed !== effective(role, action)) changes.push({ role, action, allowed });
      if (allowed !== defaultAllows(role, action)) rows.push({ role, action, allowed });
    }
  }
  if (!changes.length) return { ok: true, changed: 0 };
  await db.transaction(async (tx) => {
    await tx.delete(schema.rolePermissions);
    if (rows.length) await tx.insert(schema.rolePermissions).values(rows.map((r) => ({ ...r, updatedBy: input.actor.id, updatedAt: new Date() })));
  });
  await db.insert(schema.auditEvents).values({ actorType: "staff", actorId: input.actor.id, entityType: "roles", entityId: "matrix", action: "roles.updated", after: { changes }, occurredAt: new Date() });
  return { ok: true, changed: changes.length };
}

/** Back to the defaults for every role. */
export async function resetRolePermissions(db: AnyDb, input: { actor: Actor }) {
  const removed = await db.delete(schema.rolePermissions).returning({ role: schema.rolePermissions.role });
  if (removed.length) await db.insert(schema.auditEvents).values({ actorType: "staff", actorId: input.actor.id, entityType: "roles", entityId: "matrix", action: "roles.reset", after: { removed: removed.length }, occurredAt: new Date() });
  return { ok: true as const, removed: removed.length };
}
