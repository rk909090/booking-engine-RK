import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { assignableStaff } from "@/domain/tasks";
import { canAccessProperty, type Actor } from "@/lib/authz/permissions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One task with what its page shows: villa, booking, who made and finished it, its history and who it can go to. */
export async function taskDetail(actor: Actor, id: string) {
  if (!UUID.test(id)) return null;
  const db = getDb();
  const [row] = await db
    .select({
      task: schema.tasks,
      unitCode: schema.units.code,
      unitTypeId: schema.units.unitTypeId,
      typeContent: schema.unitTypes.content,
      assigneeName: schema.staffMembers.fullName,
      reservationCode: schema.reservations.code,
      propertyName: schema.properties.name,
      timezone: schema.properties.timezone,
    })
    .from(schema.tasks)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.tasks.propertyId))
    .leftJoin(schema.units, eq(schema.units.id, schema.tasks.unitId))
    .leftJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.units.unitTypeId))
    .leftJoin(schema.staffMembers, eq(schema.staffMembers.id, schema.tasks.assigneeId))
    .leftJoin(schema.reservations, eq(schema.reservations.id, schema.tasks.reservationId))
    .where(eq(schema.tasks.id, id));
  if (!row || !canAccessProperty(actor, row.task.propertyId)) return null;
  const [history, people, staff] = await Promise.all([
    db
      .select({ action: schema.auditEvents.action, actorType: schema.auditEvents.actorType, actorId: schema.auditEvents.actorId, occurredAt: schema.auditEvents.occurredAt })
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.entityType, "task"), eq(schema.auditEvents.entityId, id)))
      .orderBy(asc(schema.auditEvents.occurredAt)),
    assignableStaff(db, row.task.propertyId),
    db.select({ id: schema.staffMembers.id, fullName: schema.staffMembers.fullName }).from(schema.staffMembers),
  ]);
  const names = new Map(staff.map((s) => [s.id, s.fullName]));
  const nameOf = (id: string | null | undefined) => (id ? (names.get(id) ?? null) : null);
  return {
    row,
    people,
    createdByName: nameOf(row.task.createdBy),
    completedByName: nameOf(row.task.completedBy),
    history: history.map((h) => ({ ...h, actorName: nameOf(h.actorId) })),
  };
}
