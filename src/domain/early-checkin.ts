import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { queueGuestMessage } from "./notifications";
import { todayIn } from "./dates";
import { fromMinutes, toMinutes } from "./late-checkout";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Tx = Parameters<Parameters<AnyDb["transaction"]>[0]>[0];
type Executor = AnyDb | Tx;
type Actor = { type: "staff"; id: string };

/*
 * Early check-in as a request with a decision, the mirror of late check-out.
 * The villa is free from the moment the guest leaving it that day has gone
 * (the property's check-out time, or that guest's approved late check-out)
 * plus the turnover time to clean and inspect it. Earlier arrivals are
 * refused while that guest is still there.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Earliest arrival that still leaves the turnover time after a departure, and whether a time comes before it. */
export function assessEarlyCheckin(input: { requestedTime: string; departureTime: string | null; turnoverMinutes: number }) {
  if (input.departureTime === null) return { earliestAllowed: null, conflict: false };
  const earliest = toMinutes(input.departureTime) + input.turnoverMinutes;
  return { earliestAllowed: fromMinutes(earliest), conflict: toMinutes(input.requestedTime) < earliest };
}

export type PreviousDeparture = { reservationId: string; code: string; guestName: string; departureTime: string; source: "late" | "standard" };

export type EarlyCheckinCheck = {
  standardCheckIn: string;
  turnoverMinutes: number;
  previousDeparture: PreviousDeparture | null;
  earliestAllowed: string | null;
  conflict: boolean;
};

type Loaded = { r: typeof schema.reservations.$inferSelect; property: typeof schema.properties.$inferSelect };

/** The booking leaving the same villa on the day this one arrives, if any, and when it really leaves. */
async function previousDeparture(db: Executor, { r, property }: Loaded, now: Date): Promise<PreviousDeparture | null> {
  const [prev] = await db
    .select({ id: schema.reservations.id, code: schema.reservations.code, guestName: schema.guests.fullName })
    .from(schema.reservations)
    .innerJoin(schema.guests, eq(schema.guests.id, schema.reservations.guestId))
    .where(
      and(
        eq(schema.reservations.unitId, r.unitId),
        eq(schema.reservations.checkOut, r.checkIn),
        ne(schema.reservations.id, r.id),
        sql`(${schema.reservations.status} IN ('confirmed', 'in_house')
          OR (${schema.reservations.status} = 'hold' AND ${schema.reservations.holdExpiresAt} > ${now.toISOString()}::timestamptz))`,
      ),
    )
    .limit(1);
  if (!prev) return null;
  const [late] = await db
    .select({ time: schema.lateCheckoutRequests.requestedTime })
    .from(schema.lateCheckoutRequests)
    .where(
      and(
        eq(schema.lateCheckoutRequests.reservationId, prev.id),
        eq(schema.lateCheckoutRequests.forDate, r.checkIn),
        eq(schema.lateCheckoutRequests.status, "approved"),
      ),
    )
    .limit(1);
  return {
    reservationId: prev.id,
    code: prev.code,
    guestName: prev.guestName,
    departureTime: (late?.time ?? property.checkOutTime).slice(0, 5),
    source: late ? "late" : "standard",
  };
}

async function check(db: Executor, loaded: Loaded, requestedTime: string, now: Date): Promise<EarlyCheckinCheck> {
  const prev = await previousDeparture(db, loaded, now);
  return {
    standardCheckIn: loaded.property.checkInTime.slice(0, 5),
    turnoverMinutes: loaded.property.turnoverMinutes,
    previousDeparture: prev,
    ...assessEarlyCheckin({ requestedTime, departureTime: prev?.departureTime ?? null, turnoverMinutes: loaded.property.turnoverMinutes }),
  };
}

async function load(db: Executor, reservationId: string, lock: boolean): Promise<Loaded | null> {
  const query = db
    .select({ r: schema.reservations, property: schema.properties })
    .from(schema.reservations)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .where(eq(schema.reservations.id, reservationId));
  const [row] = lock ? await query.for("update", { of: schema.reservations }) : await query;
  return row ?? null;
}

async function activeRequest(db: Executor, reservationId: string) {
  const [row] = await db
    .select()
    .from(schema.earlyCheckinRequests)
    .where(and(eq(schema.earlyCheckinRequests.reservationId, reservationId), inArray(schema.earlyCheckinRequests.status, ["requested", "approved"])))
    .limit(1);
  return row ?? null;
}

async function audit(tx: Tx, r: Loaded["r"], actor: Actor, action: string, after: object, now: Date) {
  await tx.insert(schema.auditEvents).values({
    actorType: actor.type,
    actorId: actor.id,
    propertyId: r.propertyId,
    entityType: "reservation",
    entityId: r.id,
    action,
    after,
    occurredAt: now,
  });
}

/** The open request of a booking (if any) and how it fits with the previous departure right now. */
export async function earlyCheckinStatus(db: AnyDb, reservationId: string, now: Date = new Date()) {
  const loaded = await load(db, reservationId, false);
  if (!loaded) return null;
  const request = await activeRequest(db, reservationId);
  const stale = request !== null && request.forDate !== loaded.r.checkIn;
  return {
    request,
    stale,
    check: await check(db, loaded, request?.requestedTime.slice(0, 5) ?? loaded.property.checkInTime.slice(0, 5), now),
  };
}

export type EarlyCheckinError =
  | "not_found"
  | "not_allowed"
  | "after_arrival"
  | "invalid_time"
  | "already_requested"
  | "not_pending"
  | "stale"
  | "conflict"
  | "invalid_fee";

export type EarlyCheckinResult = { ok: true } | { ok: false; error: EarlyCheckinError; codes?: string[]; earliestAllowed?: string | null };

/** Records a guest's wish to arrive early. Only for confirmed bookings that have not arrived. */
export async function requestEarlyCheckin(
  db: AnyDb,
  input: { reservationId: string; time: string; note?: string | null; actor: Actor; now?: Date },
): Promise<EarlyCheckinResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const loaded = await load(tx, input.reservationId, true);
    if (!loaded) return { ok: false, error: "not_found" } as const;
    const { r, property } = loaded;
    if (r.status !== "confirmed") return { ok: false, error: "not_allowed" } as const;
    if (r.checkIn < todayIn(property.timezone, now)) return { ok: false, error: "after_arrival" } as const;
    if (!HHMM.test(input.time) || toMinutes(input.time) >= toMinutes(property.checkInTime)) return { ok: false, error: "invalid_time" } as const;
    if (await activeRequest(tx, r.id)) return { ok: false, error: "already_requested" } as const;
    await tx.insert(schema.earlyCheckinRequests).values({
      reservationId: r.id,
      forDate: r.checkIn,
      requestedTime: input.time,
      note: input.note?.trim().slice(0, 500) || null,
      requestedBy: input.actor.id,
      createdAt: now,
      updatedAt: now,
    });
    await audit(tx, r, input.actor, "early_checkin.requested", { time: input.time, forDate: r.checkIn }, now);
    return { ok: true } as const;
  });
}

/** Approves (optionally with a fee added to the bill) or declines a pending request. */
export async function decideEarlyCheckin(
  db: AnyDb,
  input: { reservationId: string; approve: boolean; fee?: number; note?: string | null; actor: Actor; now?: Date },
): Promise<EarlyCheckinResult> {
  const now = input.now ?? new Date();
  const fee = input.fee ?? 0;
  if (input.approve && (!Number.isSafeInteger(fee) || fee < 0 || fee > 1_000_000_000)) return { ok: false, error: "invalid_fee" };
  return db.transaction(async (tx) => {
    const loaded = await load(tx, input.reservationId, true);
    if (!loaded) return { ok: false, error: "not_found" } as const;
    const { r } = loaded;
    const request = await activeRequest(tx, r.id);
    if (!request || request.status !== "requested") return { ok: false, error: "not_pending" } as const;
    if (r.status !== "confirmed") return { ok: false, error: "not_allowed" } as const;
    if (request.forDate !== r.checkIn) return { ok: false, error: "stale" } as const;
    const time = request.requestedTime.slice(0, 5);
    const note = input.note?.trim().slice(0, 500) || null;

    if (!input.approve) {
      await tx
        .update(schema.earlyCheckinRequests)
        .set({ status: "declined", decisionNote: note, decidedBy: input.actor.id, decidedAt: now, updatedAt: now })
        .where(eq(schema.earlyCheckinRequests.id, request.id));
      await audit(tx, r, input.actor, "early_checkin.declined", { time, note }, now);
      await queueGuestMessage(tx, { reservationId: r.id, kind: "early_checkin_decided", payload: { approved: false, time }, now });
      return { ok: true } as const;
    }

    // Lock the villa so the departing guest's late check-out cannot be approved at the same moment.
    await tx.execute(sql`SELECT 1 FROM ${schema.units} WHERE id = ${r.unitId} FOR UPDATE`);
    const fit = await check(tx, loaded, time, now);
    if (fit.conflict) {
      return { ok: false, error: "conflict", codes: fit.previousDeparture ? [fit.previousDeparture.code] : [], earliestAllowed: fit.earliestAllowed } as const;
    }
    await tx
      .update(schema.earlyCheckinRequests)
      .set({ status: "approved", fee, decisionNote: note, decidedBy: input.actor.id, decidedAt: now, updatedAt: now })
      .where(eq(schema.earlyCheckinRequests.id, request.id));
    if (fee > 0) {
      await tx
        .update(schema.reservations)
        .set({
          extrasAmount: sql`${schema.reservations.extrasAmount} + ${fee}`,
          totalAmount: sql`${schema.reservations.totalAmount} + ${fee}`,
          updatedAt: now,
        })
        .where(eq(schema.reservations.id, r.id));
    }
    await audit(tx, r, input.actor, "early_checkin.approved", { time, fee, note }, now);
    await queueGuestMessage(tx, { reservationId: r.id, kind: "early_checkin_decided", payload: { approved: true, time, fee }, now });
    return { ok: true } as const;
  });
}

/** Withdraws a request or an approval. A fee comes off the bill; if it was already paid, it becomes a refund owed. */
export async function cancelEarlyCheckin(db: AnyDb, input: { reservationId: string; actor: Actor; now?: Date }): Promise<EarlyCheckinResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const loaded = await load(tx, input.reservationId, true);
    if (!loaded) return { ok: false, error: "not_found" } as const;
    const { r } = loaded;
    const request = await activeRequest(tx, r.id);
    if (!request) return { ok: false, error: "not_pending" } as const;
    await tx
      .update(schema.earlyCheckinRequests)
      .set({ status: "cancelled", decidedBy: input.actor.id, decidedAt: now, updatedAt: now })
      .where(eq(schema.earlyCheckinRequests.id, request.id));
    if (request.status === "approved" && request.fee > 0) {
      const total = r.totalAmount - request.fee;
      const overpaid = r.amountPaid - total;
      await tx
        .update(schema.reservations)
        .set({
          extrasAmount: r.extrasAmount - request.fee,
          totalAmount: total,
          refundAmount: overpaid > (r.refundAmount ?? 0) ? overpaid : r.refundAmount,
          updatedAt: now,
        })
        .where(eq(schema.reservations.id, r.id));
    }
    await audit(tx, r, input.actor, "early_checkin.cancelled", { time: request.requestedTime.slice(0, 5), fee: request.fee }, now);
    return { ok: true } as const;
  });
}
