import "server-only";
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { isIsoDate, todayIn } from "@/domain/dates";
import { unitIsFree } from "@/domain/booking";
import { readiness } from "@/domain/housekeeping";
import { assessEarlyCheckin } from "@/domain/early-checkin";
import { assessLateCheckout } from "@/domain/late-checkout";
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
  /** "pending": a late check-out or early check-in request waits for a decision. */
  requests?: string;
  /** "open": confirmed without deposit and still owing it; "overdue": past its due date. */
  deposit?: string;
  /** Today's date, for "overdue". */
  today?: string;
  page?: number;
  /** Rows per page (exports ask for many at once). */
  pageSize?: number;
};

function scope(actor: Actor): SQL | undefined {
  if (hasGlobalScope(actor)) return undefined;
  if (actor.propertyIds.length === 0) return sql`false`;
  return inArray(schema.reservations.propertyId, [...actor.propertyIds]);
}

export async function visibleProperties(actor: Actor) {
  const rows = await getDb()
    .select({
      id: schema.properties.id,
      slug: schema.properties.slug,
      name: schema.properties.name,
      timezone: schema.properties.timezone,
      checkInTime: schema.properties.checkInTime,
      checkOutTime: schema.properties.checkOutTime,
      turnoverMinutes: schema.properties.turnoverMinutes,
      discountLimitFrontOfficeBp: schema.properties.discountLimitFrontOfficeBp,
      discountLimitManagerBp: schema.properties.discountLimitManagerBp,
    })
    .from(schema.properties)
    .orderBy(asc(schema.properties.name));
  return rows.filter((p) => canAccessProperty(actor, p.id));
}

const refundPaid = sql<number>`coalesce((
  SELECT sum(p.amount) FROM ${schema.payments} p
  WHERE p.reservation_id = ${schema.reservations.id} AND p.purpose = 'refund' AND p.status = 'paid'
), 0)::bigint`;

/** Confirmed without the deposit and still owing it (see domain/guarantee.ts). */
const depositOpen = sql`(${schema.reservations.status} IN ('confirmed', 'in_house') AND ${schema.reservations.guarantee} IS NOT NULL
  AND ${schema.reservations.amountPaid} < least(${schema.reservations.depositAmount}, ${schema.reservations.totalAmount}))`;
const depositOverdue = (today: string) => sql`(${depositOpen} AND (${schema.reservations.guarantee} ->> 'payBy') < ${today})`;

/** A late check-out or early check-in request on this booking waits for a decision. */
const requestPending = sql<boolean>`(EXISTS (SELECT 1 FROM ${schema.lateCheckoutRequests} l WHERE l.reservation_id = ${schema.reservations.id} AND l.status = 'requested')
  OR EXISTS (SELECT 1 FROM ${schema.earlyCheckinRequests} e WHERE e.reservation_id = ${schema.reservations.id} AND e.status = 'requested')
  OR EXISTS (SELECT 1 FROM ${schema.addonOrders} a WHERE a.reservation_id = ${schema.reservations.id} AND a.status = 'requested')
  OR EXISTS (SELECT 1 FROM ${schema.dateChangeRequests} d WHERE d.reservation_id = ${schema.reservations.id} AND d.status = 'requested'))`;

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
    filters.requests === "pending" ? requestPending : undefined,
    filters.deposit === "open" ? depositOpen : filters.deposit === "overdue" && isIsoDate(filters.today) ? depositOverdue(filters.today) : undefined,
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
      depositAmount: schema.reservations.depositAmount,
      guarantee: schema.reservations.guarantee,
      requestPending,
      preCheckinDone: sql<boolean>`EXISTS (SELECT 1 FROM ${schema.preCheckins} pc WHERE pc.reservation_id = ${schema.reservations.id})`,
      refundAmount: schema.reservations.refundAmount,
      refundPaid,
      guestName: schema.guests.fullName,
      guestTags: schema.guests.tags,
      /** Stays of this guest that ended before this booking (a returning guest). */
      guestPastStays: sql<number>`(SELECT count(*)::int FROM ${schema.reservations} p WHERE p.guest_id = ${schema.reservations.guestId} AND p.status = 'checked_out' AND p.check_out <= ${schema.reservations.checkIn})`,
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
      .limit(filters.pageSize ?? PAGE_SIZE)
      .offset((page - 1) * (filters.pageSize ?? PAGE_SIZE)),
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
      deposit: filters.deposit === "open" || filters.deposit === "overdue" ? filters.deposit : "",
      requests: filters.requests === "pending" ? "pending" : "",
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
  if (!property) return { properties, property: null, units: [], stays: [], blocks: [] };

  const [units, stays] = await Promise.all([
    db
      .select({ id: schema.units.id, code: schema.units.code, name: schema.units.name, typeName: schema.unitTypes.name, unitTypeId: schema.units.unitTypeId })
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
  const blocks = await db
    .select({
      id: schema.unitBlocks.id,
      unitId: schema.unitBlocks.unitId,
      startDate: schema.unitBlocks.startDate,
      endDate: schema.unitBlocks.endDate,
      reason: schema.unitBlocks.reason,
    })
    .from(schema.unitBlocks)
    .innerJoin(schema.units, eq(schema.units.id, schema.unitBlocks.unitId))
    .where(
      and(
        eq(schema.units.propertyId, property.id),
        eq(schema.unitBlocks.status, "open"),
        sql`daterange(${schema.unitBlocks.startDate}, ${schema.unitBlocks.endDate}, '[)') && daterange(${from}::date, ${to}::date, '[)')`,
      ),
    );
  // Stays imported from other channels (Airbnb, Booking.com…) block the villa too.
  const channelStays = await db
    .select({
      id: schema.icalEvents.id,
      unitId: schema.icalEvents.unitId,
      startDate: schema.icalEvents.startDate,
      endDate: schema.icalEvents.endDate,
      reason: schema.icalFeeds.name,
    })
    .from(schema.icalEvents)
    .innerJoin(schema.icalFeeds, eq(schema.icalFeeds.id, schema.icalEvents.feedId))
    .innerJoin(schema.units, eq(schema.units.id, schema.icalEvents.unitId))
    .where(
      and(
        eq(schema.units.propertyId, property.id),
        sql`daterange(${schema.icalEvents.startDate}, ${schema.icalEvents.endDate}, '[)') && daterange(${from}::date, ${to}::date, '[)')`,
      ),
    );
  return {
    properties,
    property,
    units,
    stays,
    blocks: [...blocks.map((b) => ({ ...b, kind: "maintenance" as const })), ...channelStays.map((b) => ({ ...b, kind: "channel" as const }))],
  };
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
      depositsOverdue: sql<number>`count(*) FILTER (WHERE ${depositOverdue(today)})::int`,
      requestsPending: sql<number>`count(*) FILTER (WHERE ${requestPending} AND ${schema.reservations.status} IN ('confirmed', 'in_house'))::int`,
    })
    .from(schema.reservations)
    .where(scope(actor));
  return row;
}

/** Every unit of one property with what it needs today, most urgent first. */
export async function villaStatus(actor: Actor, propertySlug: string | undefined, now: Date) {
  const db = getDb();
  const properties = await visibleProperties(actor);
  const property = properties.find((p) => p.slug === propertySlug) ?? properties[0];
  if (!property) return { properties, property: null, today: "", units: [] };
  const today = todayIn(property.timezone, now);

  const [units, stays, blocks, lastEvents, lateCheckouts, earlyCheckins] = await Promise.all([
    db
      .select({
        id: schema.units.id,
        code: schema.units.code,
        name: schema.units.name,
        typeName: schema.unitTypes.name,
        state: schema.unitStatus.state,
        stateNote: schema.unitStatus.note,
        stateAt: schema.unitStatus.updatedAt,
      })
      .from(schema.units)
      .innerJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.units.unitTypeId))
      .leftJoin(schema.unitStatus, eq(schema.unitStatus.unitId, schema.units.id))
      .where(and(eq(schema.units.propertyId, property.id), eq(schema.units.isActive, true)))
      .orderBy(asc(schema.units.code)),
    db
      .select({
        id: schema.reservations.id,
        unitId: schema.reservations.unitId,
        code: schema.reservations.code,
        status: schema.reservations.status,
        checkIn: schema.reservations.checkIn,
        checkOut: schema.reservations.checkOut,
        eta: schema.reservations.estimatedArrival,
        guestName: schema.guests.fullName,
      })
      .from(schema.reservations)
      .innerJoin(schema.guests, eq(schema.guests.id, schema.reservations.guestId))
      .where(
        and(
          eq(schema.reservations.propertyId, property.id),
          or(
            eq(schema.reservations.status, "in_house"),
            and(eq(schema.reservations.status, "confirmed"), eq(schema.reservations.checkIn, today)),
          ),
        ),
      ),
    db
      .select()
      .from(schema.unitBlocks)
      .innerJoin(schema.units, eq(schema.units.id, schema.unitBlocks.unitId))
      .where(and(eq(schema.units.propertyId, property.id), eq(schema.unitBlocks.status, "open"), gte(schema.unitBlocks.endDate, today)))
      .orderBy(asc(schema.unitBlocks.startDate)),
    db
      .selectDistinctOn([schema.housekeepingEvents.unitId], {
        unitId: schema.housekeepingEvents.unitId,
        toState: schema.housekeepingEvents.toState,
        actorId: schema.housekeepingEvents.actorId,
        occurredAt: schema.housekeepingEvents.occurredAt,
      })
      .from(schema.housekeepingEvents)
      .innerJoin(schema.units, eq(schema.units.id, schema.housekeepingEvents.unitId))
      .where(eq(schema.units.propertyId, property.id))
      .orderBy(schema.housekeepingEvents.unitId, desc(schema.housekeepingEvents.occurredAt)),
    db
      .select({ reservationId: schema.lateCheckoutRequests.reservationId, time: schema.lateCheckoutRequests.requestedTime, status: schema.lateCheckoutRequests.status })
      .from(schema.lateCheckoutRequests)
      .innerJoin(schema.reservations, eq(schema.reservations.id, schema.lateCheckoutRequests.reservationId))
      .where(
        and(
          eq(schema.reservations.propertyId, property.id),
          eq(schema.lateCheckoutRequests.forDate, today),
          inArray(schema.lateCheckoutRequests.status, ["requested", "approved"]),
        ),
      ),
    db
      .select({ reservationId: schema.earlyCheckinRequests.reservationId, time: schema.earlyCheckinRequests.requestedTime, status: schema.earlyCheckinRequests.status })
      .from(schema.earlyCheckinRequests)
      .innerJoin(schema.reservations, eq(schema.reservations.id, schema.earlyCheckinRequests.reservationId))
      .where(
        and(
          eq(schema.reservations.propertyId, property.id),
          eq(schema.earlyCheckinRequests.forDate, today),
          inArray(schema.earlyCheckinRequests.status, ["requested", "approved"]),
        ),
      ),
  ]);

  const staffNames = new Map(
    (await db.select({ id: schema.staffMembers.id, name: schema.staffMembers.fullName }).from(schema.staffMembers)).map((s) => [s.id, s.name]),
  );

  const rows = units.map((u) => {
    const inHouse = stays.find((s) => s.unitId === u.id && s.status === "in_house") ?? null;
    const arrival = stays.find((s) => s.unitId === u.id && s.status === "confirmed" && s.checkIn === today) ?? null;
    const unitBlocks = blocks.filter((b) => b.unit_blocks.unitId === u.id).map((b) => b.unit_blocks);
    const blockToday = unitBlocks.find((b) => b.startDate <= today && today < b.endDate) ?? null;
    const state = u.state ?? "ready";
    const r = readiness({
      state,
      occupied: Boolean(inHouse),
      blockedToday: Boolean(blockToday),
      arrivalToday: Boolean(arrival),
      departingToday: inHouse?.checkOut === today,
    });
    const last = lastEvents.find((e) => e.unitId === u.id) ?? null;
    // A guest leaving late today, and whether that still leaves time to prepare for the arrival.
    const late = inHouse?.checkOut === today ? (lateCheckouts.find((l) => l.reservationId === inHouse.id) ?? null) : null;
    const early = arrival ? (earlyCheckins.find((e) => e.reservationId === arrival.id) ?? null) : null;
    // When the arriving guest needs the villa, and when the departing guest really leaves (same rules as the requests).
    const standardIn = property.checkInTime.slice(0, 5);
    const eta = arrival?.eta?.slice(0, 5) ?? null;
    const readyBy = arrival ? (early?.status === "approved" ? early.time.slice(0, 5) : eta && eta > standardIn ? eta : standardIn) : null;
    const leavesAt = inHouse?.checkOut === today ? (late?.status === "approved" ? late.time.slice(0, 5) : property.checkOutTime.slice(0, 5)) : null;
    const lateCheckout = late
      ? {
          time: late.time.slice(0, 5),
          approved: late.status === "approved",
          ...assessLateCheckout({ requestedTime: late.time.slice(0, 5), arrivalTime: readyBy, turnoverMinutes: property.turnoverMinutes }),
        }
      : null;
    const earlyCheckin = early
      ? {
          time: early.time.slice(0, 5),
          approved: early.status === "approved",
          ...assessEarlyCheckin({ requestedTime: early.time.slice(0, 5), departureTime: leavesAt, turnoverMinutes: property.turnoverMinutes }),
        }
      : null;
    return {
      lateCheckout,
      earlyCheckin,
      ...u,
      state,
      readiness: r.readiness,
      priority: r.priority,
      needsAttention: r.needsAttention,
      inHouse,
      departingToday: inHouse?.checkOut === today,
      arrival,
      blockToday,
      upcomingBlocks: unitBlocks.filter((b) => b !== blockToday),
      lastChange: last ? { ...last, actorName: last.actorId ? (staffNames.get(last.actorId) ?? null) : null } : null,
    };
  });
  rows.sort((a, b) => a.priority - b.priority || (a.arrival?.eta ?? "99").localeCompare(b.arrival?.eta ?? "99") || a.code.localeCompare(b.code));
  return { properties, property, today, units: rows };
}

/** Active villas of one type, for choosing where to move a booking. */
export async function sameTypeUnits(unitTypeId: string) {
  return getDb()
    .select({ id: schema.units.id, code: schema.units.code, name: schema.units.name })
    .from(schema.units)
    .where(and(eq(schema.units.unitTypeId, unitTypeId), eq(schema.units.isActive, true)))
    .orderBy(asc(schema.units.code));
}

/** Villas of one type free for every night of [checkIn, checkOut). */
export async function freeUnitsOfType(unitTypeId: string, checkIn: string, checkOut: string, now: Date) {
  return getDb()
    .select({ id: schema.units.id, code: schema.units.code })
    .from(schema.units)
    .where(and(eq(schema.units.unitTypeId, unitTypeId), eq(schema.units.isActive, true), unitIsFree(checkIn, checkOut, now)))
    .orderBy(asc(schema.units.code));
}
