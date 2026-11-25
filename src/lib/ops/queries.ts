import "server-only";
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { isIsoDate } from "@/domain/dates";
import { canAccessProperty, hasGlobalScope, type Actor } from "@/lib/authz/permissions";

/*
 * Read models for the staff area. Every query is limited to the properties
 * the actor may see; a reservation outside that scope is reported as not
 * found, so its existence does not leak.
 */

export const PAGE_SIZE = 25;
const STATUSES = schema.reservationStatus.enumValues;
export type ReservationStatus = (typeof STATUSES)[number];

export type ReservationFilters = {
  q?: string;
  status?: string;
  property?: string;
  from?: string;
  to?: string;
  /** Exact departure date. */
  departOn?: string;
  /** "due": only reservations with a refund not yet paid out. */
  refund?: string;
  page?: number;
};

function scope(actor: Actor): SQL | undefined {
  if (hasGlobalScope(actor)) return undefined;
  if (actor.propertyIds.length === 0) return sql`false`;
  return inArray(schema.reservations.propertyId, [...actor.propertyIds]);
}

export async function visibleProperties(actor: Actor) {
  const rows = await getDb()
    .select({ id: schema.properties.id, slug: schema.properties.slug, name: schema.properties.name, timezone: schema.properties.timezone })
    .from(schema.properties)
    .orderBy(asc(schema.properties.name));
  return rows.filter((p) => canAccessProperty(actor, p.id));
}

const refundPaid = sql<number>`coalesce((
  SELECT sum(p.amount) FROM ${schema.payments} p
  WHERE p.reservation_id = ${schema.reservations.id} AND p.purpose = 'refund' AND p.status = 'paid'
), 0)::bigint`;

export async function listReservations(actor: Actor, filters: ReservationFilters) {
  const db = getDb();
  const properties = await visibleProperties(actor);
  const property = properties.find((p) => p.slug === filters.property);
  const status = STATUSES.find((s) => s === filters.status);
  const q = filters.q?.trim().slice(0, 100);
  const page = Math.max(1, Math.floor(filters.page ?? 1));

  const where = and(
    scope(actor),
    property ? eq(schema.reservations.propertyId, property.id) : undefined,
    status ? eq(schema.reservations.status, status) : undefined,
    filters.from && isIsoDate(filters.from) ? gte(schema.reservations.checkIn, filters.from) : undefined,
    filters.to && isIsoDate(filters.to) ? lte(schema.reservations.checkIn, filters.to) : undefined,
    filters.departOn && isIsoDate(filters.departOn) ? eq(schema.reservations.checkOut, filters.departOn) : undefined,
    filters.refund === "due" ? sql`coalesce(${schema.reservations.refundAmount}, 0) > ${refundPaid}` : undefined,
    q
      ? or(
          ilike(schema.reservations.code, `%${q}%`),
          ilike(schema.guests.fullName, `%${q}%`),
          ilike(schema.guests.email, `%${q}%`),
        )
      : undefined,
  );

  const base = db
    .select({
      id: schema.reservations.id,
      code: schema.reservations.code,
      status: schema.reservations.status,
      source: schema.reservations.source,
      checkIn: schema.reservations.checkIn,
      checkOut: schema.reservations.checkOut,
      adults: schema.reservations.adults,
      children: schema.reservations.children,
      totalAmount: schema.reservations.totalAmount,
      amountPaid: schema.reservations.amountPaid,
      refundAmount: schema.reservations.refundAmount,
      refundPaid,
      guestName: schema.guests.fullName,
      unitCode: schema.units.code,
      typeName: schema.unitTypes.name,
      propertyName: schema.properties.name,
    })
    .from(schema.reservations)
    .innerJoin(schema.guests, eq(schema.guests.id, schema.reservations.guestId))
    .innerJoin(schema.units, eq(schema.units.id, schema.reservations.unitId))
    .innerJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.reservations.unitTypeId))
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .where(where);

  const [rows, [{ total }]] = await Promise.all([
    base
      .orderBy(desc(schema.reservations.checkIn), desc(schema.reservations.createdAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db
      .select({ total: count() })
      .from(schema.reservations)
      .innerJoin(schema.guests, eq(schema.guests.id, schema.reservations.guestId))
      .where(where),
  ]);

  return {
    rows: rows.map((r) => ({ ...r, refundOutstanding: Math.max(0, (r.refundAmount ?? 0) - Number(r.refundPaid)) })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    properties,
    applied: {
      q: q ?? "",
      status: status ?? "",
      property: property?.slug ?? "",
      from: filters.from ?? "",
      to: filters.to ?? "",
      departOn: filters.departOn && isIsoDate(filters.departOn) ? filters.departOn : "",
      refund: filters.refund === "due" ? "due" : "",
    },
  };
}

export async function getReservationForStaff(actor: Actor, code: string) {
  const db = getDb();
  const [row] = await db
    .select({
      reservation: schema.reservations,
      guest: schema.guests,
      unit: schema.units,
      typeName: schema.unitTypes.name,
      property: schema.properties,
    })
    .from(schema.reservations)
    .innerJoin(schema.guests, eq(schema.guests.id, schema.reservations.guestId))
    .innerJoin(schema.units, eq(schema.units.id, schema.reservations.unitId))
    .innerJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.reservations.unitTypeId))
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .where(eq(schema.reservations.code, code.toUpperCase()))
    .limit(1);
  if (!row || !canAccessProperty(actor, row.reservation.propertyId)) return null;

  const [payments, activity] = await Promise.all([
    db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.reservationId, row.reservation.id))
      .orderBy(asc(schema.payments.createdAt)),
    db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.entityType, "reservation"), eq(schema.auditEvents.entityId, row.reservation.id)))
      .orderBy(desc(schema.auditEvents.occurredAt)),
  ]);
  return { ...row, payments, activity };
}

/** Units of one property and the bookings that occupy them in [from, to). */
export async function calendarData(actor: Actor, propertySlug: string | undefined, from: string, to: string, now: Date) {
  const db = getDb();
  const properties = await visibleProperties(actor);
  const property = properties.find((p) => p.slug === propertySlug) ?? properties[0];
  if (!property) return { properties, property: null, units: [], stays: [] };

  const [units, stays] = await Promise.all([
    db
      .select({ id: schema.units.id, code: schema.units.code, name: schema.units.name, typeName: schema.unitTypes.name })
      .from(schema.units)
      .innerJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.units.unitTypeId))
      .where(and(eq(schema.units.propertyId, property.id), eq(schema.units.isActive, true)))
      .orderBy(asc(schema.unitTypes.sortOrder), asc(schema.units.code)),
    db
      .select({
        code: schema.reservations.code,
        unitId: schema.reservations.unitId,
        status: schema.reservations.status,
        checkIn: schema.reservations.checkIn,
        checkOut: schema.reservations.checkOut,
        guestName: schema.guests.fullName,
      })
      .from(schema.reservations)
      .innerJoin(schema.guests, eq(schema.guests.id, schema.reservations.guestId))
      .where(
        and(
          eq(schema.reservations.propertyId, property.id),
          sql`daterange(${schema.reservations.checkIn}, ${schema.reservations.checkOut}, '[)') && daterange(${from}::date, ${to}::date, '[)')`,
          or(
            inArray(schema.reservations.status, ["confirmed", "in_house", "checked_out"]),
            and(eq(schema.reservations.status, "hold"), sql`${schema.reservations.holdExpiresAt} > ${now.toISOString()}::timestamptz`),
          ),
        ),
      ),
  ]);
  return { properties, property, units, stays };
}

/** Today's figures for the staff home page, within the actor's scope. */
export async function todayCounts(actor: Actor, today: string) {
  const db = getDb();
  const [row] = await db
    .select({
      arrivals: sql<number>`count(*) FILTER (WHERE ${schema.reservations.checkIn} = ${today} AND ${schema.reservations.status} IN ('confirmed', 'in_house'))::int`,
      departures: sql<number>`count(*) FILTER (WHERE ${schema.reservations.checkOut} = ${today} AND ${schema.reservations.status} IN ('in_house', 'checked_out'))::int`,
      inHouse: sql<number>`count(*) FILTER (WHERE ${schema.reservations.status} = 'in_house')::int`,
      refundsDue: sql<number>`count(*) FILTER (WHERE coalesce(${schema.reservations.refundAmount}, 0) > ${refundPaid})::int`,
    })
    .from(schema.reservations)
    .where(scope(actor));
  return row;
}
