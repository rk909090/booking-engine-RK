import "server-only";
import { and, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { hasGlobalScope, roles, type Actor } from "@/lib/authz/permissions";

/*
 * Staff for the users pages. Directors see everyone; a branch manager sees
 * the non-director staff of their own properties (read only).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function visibleTo(actor: Actor) {
  if (hasGlobalScope(actor)) return undefined;
  if (!actor.propertyIds.length) return sql`false`;
  return and(
    ne(schema.staffMembers.role, "director"),
    sql`EXISTS (SELECT 1 FROM ${schema.staffPropertyAccess} a WHERE a.staff_id = ${schema.staffMembers.id} AND a.property_id IN (${sql.join(
      actor.propertyIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}))`,
  );
}

const columns = {
  id: schema.staffMembers.id,
  fullName: schema.staffMembers.fullName,
  email: schema.staffMembers.email,
  role: schema.staffMembers.role,
  isActive: schema.staffMembers.isActive,
  createdAt: schema.staffMembers.createdAt,
  authUserId: schema.staffMembers.authUserId,
  twoFactorEnabled: sql<boolean>`coalesce(${schema.authUsers.twoFactorEnabled}, false)`,
  lastSeen: sql<Date | null>`(SELECT max(s.updated_at) FROM ${schema.authSessions} s WHERE s.user_id = ${schema.staffMembers.authUserId})`,
  propertyIds: sql<string[]>`coalesce((SELECT array_agg(a.property_id::text) FROM ${schema.staffPropertyAccess} a WHERE a.staff_id = ${schema.staffMembers.id}), '{}')`,
};

export async function listStaff(actor: Actor, filters: { q?: string; role?: string; status?: string }) {
  const q = filters.q?.trim().slice(0, 80);
  const role = (roles as readonly string[]).includes(filters.role ?? "") ? (filters.role as (typeof roles)[number]) : undefined;
  return getDb()
    .select(columns)
    .from(schema.staffMembers)
    .leftJoin(schema.authUsers, eq(schema.authUsers.id, schema.staffMembers.authUserId))
    .where(
      and(
        visibleTo(actor),
        q ? or(ilike(schema.staffMembers.fullName, `%${q}%`), ilike(schema.staffMembers.email, `%${q}%`)) : undefined,
        role ? eq(schema.staffMembers.role, role) : undefined,
        filters.status === "active" ? eq(schema.staffMembers.isActive, true) : filters.status === "inactive" ? eq(schema.staffMembers.isActive, false) : undefined,
      ),
    )
    .orderBy(desc(schema.staffMembers.isActive), schema.staffMembers.fullName);
}

/** One staff member with what they did lately and the changes to their account. */
export async function staffDetail(actor: Actor, id: string) {
  if (!UUID.test(id)) return null;
  const db = getDb();
  const [member] = await db
    .select(columns)
    .from(schema.staffMembers)
    .leftJoin(schema.authUsers, eq(schema.authUsers.id, schema.staffMembers.authUserId))
    .where(and(eq(schema.staffMembers.id, id), visibleTo(actor)));
  if (!member) return null;
  const [activity, changes, names] = await Promise.all([
    db
      .select({ action: schema.auditEvents.action, entityType: schema.auditEvents.entityType, occurredAt: schema.auditEvents.occurredAt })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.actorId, id))
      .orderBy(desc(schema.auditEvents.occurredAt))
      .limit(12),
    db
      .select({ action: schema.auditEvents.action, actorId: schema.auditEvents.actorId, actorType: schema.auditEvents.actorType, occurredAt: schema.auditEvents.occurredAt })
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.entityType, "staff_member"), eq(schema.auditEvents.entityId, id)))
      .orderBy(desc(schema.auditEvents.occurredAt))
      .limit(20),
    db.select({ id: schema.staffMembers.id, fullName: schema.staffMembers.fullName }).from(schema.staffMembers),
  ]);
  const nameOf = new Map(names.map((n) => [n.id, n.fullName]));
  return { member, activity, changes: changes.map((c) => ({ ...c, actorName: c.actorId ? (nameOf.get(c.actorId) ?? null) : null })) };
}

export async function allProperties() {
  return getDb().select({ id: schema.properties.id, slug: schema.properties.slug, name: schema.properties.name }).from(schema.properties).orderBy(schema.properties.name);
}

export async function staffEmailTaken(email: string) {
  const [row] = await getDb().select({ id: schema.staffMembers.id }).from(schema.staffMembers).where(eq(schema.staffMembers.email, email.trim().toLowerCase()));
  return Boolean(row);
}

