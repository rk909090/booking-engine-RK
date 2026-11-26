import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { permissionsFor, type Actor, type Role } from "@/lib/authz/permissions";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export type StaffProfile = {
  staffId: string;
  fullName: string;
  email: string;
  role: Role;
  twoFactorEnabled: boolean;
  actor: Actor;
};

/**
 * Turns a signed-in auth user into a staff actor for permission checks (with
 * the role's saved permission changes), in two queries. Returns null when no active staff record is linked to that user.
 */
export async function loadStaffProfile(
  db: AnyDb,
  authUser: { id: string; twoFactorEnabled?: boolean | null },
): Promise<StaffProfile | null> {
  const [row] = await db
    .select({
      id: schema.staffMembers.id,
      fullName: schema.staffMembers.fullName,
      email: schema.staffMembers.email,
      role: schema.staffMembers.role,
      isActive: schema.staffMembers.isActive,
      propertyIds: sql<string[]>`coalesce(array_agg(${schema.staffPropertyAccess.propertyId}::text) filter (where ${schema.staffPropertyAccess.propertyId} is not null), '{}')`,
    })
    .from(schema.staffMembers)
    .leftJoin(schema.staffPropertyAccess, eq(schema.staffPropertyAccess.staffId, schema.staffMembers.id))
    .where(and(eq(schema.staffMembers.authUserId, authUser.id), eq(schema.staffMembers.isActive, true)))
    .groupBy(schema.staffMembers.id)
    .limit(1);
  if (!row) return null;
  const overrides = await db.select({ role: schema.rolePermissions.role, action: schema.rolePermissions.action, allowed: schema.rolePermissions.allowed }).from(schema.rolePermissions).where(eq(schema.rolePermissions.role, row.role));

  return {
    staffId: row.id,
    fullName: row.fullName,
    email: row.email,
    role: row.role,
    twoFactorEnabled: authUser.twoFactorEnabled === true,
    actor: {
      staffId: row.id,
      role: row.role,
      isActive: row.isActive,
      propertyIds: row.propertyIds,
      permissions: permissionsFor(row.role, overrides),
    },
  };
}
