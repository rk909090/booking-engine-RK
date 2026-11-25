import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { todayIn } from "./dates";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Tx = Parameters<Parameters<AnyDb["transaction"]>[0]>[0];
type Executor = AnyDb | Tx;
/** Staff at the desk, or the guest from their booking page (no id). */
type Actor = { type: "staff"; id: string } | { type: "guest"; id: null };

/*
 * Late check-out as a request with a decision, instead of free text (the
 * reference demo's bug B3). The villa must be cleaned and inspected before the
 * next guest arrives, so the latest possible departure is the time that guest
 * needs the villa minus the property's turnover time. That time is their
 * approved early check-in, otherwise the property's check-in time (or their
 * ETA when it is later: a guest arriving at 18:00 does not need the villa at
 * 14:00; one arriving at 10:00 without an approved early check-in waits). Approval is refused past that point; staff can
 * move the arriving guest to another villa first.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function toMinutes(time: string): number {
  const [h, m] = time.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

export function fromMinutes(minutes: number): string {
  const m = Math.max(0, minutes);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Latest departure that still leaves the turnover time before an arrival, and whether a time goes past it. */
export function assessLateCheckout(input: { requestedTime: string; arrivalTime: string | null; turnoverMinutes: number }) {
  if (input.arrivalTime === null) return { latestAllowed: null, conflict: false };
  const latest = toMinutes(input.arrivalTime) - input.turnoverMinutes;
  return { latestAllowed: fromMinutes(latest), conflict: toMinutes(input.requestedTime) > latest };
}

export type NextArrival = {
  reservationId: string;
  code: string;
  guestName: string;
  /** When the villa must be ready for them. */
  arrivalTime: string;
  /** Where that time comes from. */
  source: "early" | "eta" | "standard";
};

export type LateCheckoutCheck = {
  standardCheckOut: string;
  turnoverMinutes: number;
  nextArrival: NextArrival | null;
  latestAllowed: string | null;
  conflict: boolean;
};

type Loaded = { r: typeof schema.reservations.$inferSelect; property: typeof schema.properties.$inferSelect };

/** The booking arriving in the same villa on the day this one leaves, if any. */
async function nextArrival(db: Executor, { r, property }: Loaded, now: Date): Promise<NextArrival | null> {
  const [next] = await db
    .select({ id: schema.reservations.id, code: schema.reservations.code, eta: schema.reservations.estimatedArrival, guestName: schema.guests.fullName })
    .from(schema.reservations)
    .innerJoin(schema.guests, eq(schema.guests.id, schema.reservations.guestId))
    .where(
      and(
        eq(schema.reservations.unitId, r.unitId),
        eq(schema.reservations.checkIn, r.checkOut),
        ne(schema.reservations.id, r.id),
        sql`(${schema.reservations.status} IN ('confirmed', 'in_house')
          OR (${schema.reservations.status} = 'hold' AND ${schema.reservations.holdExpiresAt} > ${now.toISOString()}::timestamptz))`,
      ),
    )
    .limit(1);
  if (!next) return null;
  const [early] = await db
    .select({ time: schema.earlyCheckinRequests.requestedTime })
    .from(schema.earlyCheckinRequests)
    .where(
      and(
        eq(schema.earlyCheckinRequests.reservationId, next.id),
        eq(schema.earlyCheckinRequests.forDate, r.checkOut),
        eq(schema.earlyCheckinRequests.status, "approved"),
      ),
    )
    .limit(1);
  const standard = property.checkInTime.slice(0, 5);
  const eta = next.eta?.slice(0, 5) ?? null;
  const [arrivalTime, source]: [string, NextArrival["source"]] = early
    ? [early.time.slice(0, 5), "early"]
    : eta && eta > standard
      ? [eta, "eta"]
      : [standard, "standard"];
  return { reservationId: next.id, code: next.code, guestName: next.guestName, arrivalTime, source };
}

async function check(db: Executor, loaded: Loaded, requestedTime: string, now: Date): Promise<LateCheckoutCheck> {
  const arrival = await nextArrival(db, loaded, now);
  const assessed = assessLateCheckout({ requestedTime, arrivalTime: arrival?.arrivalTime ?? null, turnoverMinutes: loaded.property.turnoverMinutes });
  return {
    standardCheckOut: loaded.property.checkOutTime.slice(0, 5),
    turnoverMinutes: loaded.property.turnoverMinutes,
    nextArrival: arrival,
    ...assessed,
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

const ACTIVE = ["requested", "approved"] as const;

async function activeRequest(db: Executor, reservationId: string) {
  const [row] = await db
    .select()
    .from(schema.lateCheckoutRequests)
    .where(and(eq(schema.lateCheckoutRequests.reservationId, reservationId), inArray(schema.lateCheckoutRequests.status, ACTIVE)))
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

/** The open request of a booking (if any) and how it fits with the next arrival right now. */
export async function lateCheckoutStatus(db: AnyDb, reservationId: string, now: Date = new Date()) {
  const loaded = await load(db, reservationId, false);
  if (!loaded) return null;
  const request = await activeRequest(db, reservationId);
  const stale = request !== null && request.forDate !== loaded.r.checkOut;
  return {
    request,
    stale,
    check: await check(db, loaded, request?.requestedTime.slice(0, 5) ?? loaded.property.checkOutTime.slice(0, 5), now),
  };
}

export type LateCheckoutError =
  | "not_found"
  | "not_allowed"
  | "after_departure"
  | "invalid_time"
  | "already_requested"
  | "not_pending"
  | "stale"
  | "conflict"
  | "invalid_fee"
  | "time_unavailable";

export type LateCheckoutResult = { ok: true } | { ok: false; error: LateCheckoutError; codes?: string[]; latestAllowed?: string | null };

/** Records a guest's wish to leave later. Anyone running the desk can record it; approving is separate. */
export async function requestLateCheckout(
  db: AnyDb,
  input: { reservationId: string; time: string; note?: string | null; actor: Actor; now?: Date },
): Promise<LateCheckoutResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const loaded = await load(tx, input.reservationId, true);
    if (!loaded) return { ok: false, error: "not_found" } as const;
    const { r, property } = loaded;
    if (r.status !== "confirmed" && r.status !== "in_house") return { ok: false, error: "not_allowed" } as const;
    if (r.checkOut < todayIn(property.timezone, now)) return { ok: false, error: "after_departure" } as const;
    if (!HHMM.test(input.time) || toMinutes(input.time) <= toMinutes(property.checkOutTime)) return { ok: false, error: "invalid_time" } as const;
    if (await activeRequest(tx, r.id)) return { ok: false, error: "already_requested" } as const;
    await tx.insert(schema.lateCheckoutRequests).values({
      reservationId: r.id,
      forDate: r.checkOut,
      requestedTime: input.time,
      note: input.note?.trim().slice(0, 500) || null,
      requestedBy: input.actor.id ?? "guest",
      createdAt: now,
      updatedAt: now,
    });
    await audit(tx, r, input.actor, "late_checkout.requested", { time: input.time, forDate: r.checkOut }, now);
    return { ok: true } as const;
  });
}

/** Approves (optionally with a fee added to the bill) or declines a pending request. */
export async function decideLateCheckout(
  db: AnyDb,
  input: { reservationId: string; approve: boolean; fee?: number; note?: string | null; actor: Actor; now?: Date },
): Promise<LateCheckoutResult> {
  const now = input.now ?? new Date();
  const fee = input.fee ?? 0;
  if (input.approve && (!Number.isSafeInteger(fee) || fee < 0 || fee > 1_000_000_000)) return { ok: false, error: "invalid_fee" };
  return db.transaction(async (tx) => {
    const loaded = await load(tx, input.reservationId, true);
    if (!loaded) return { ok: false, error: "not_found" } as const;
    const { r } = loaded;
    const request = await activeRequest(tx, r.id);
    if (!request || request.status !== "requested") return { ok: false, error: "not_pending" } as const;
    if (r.status !== "confirmed" && r.status !== "in_house") return { ok: false, error: "not_allowed" } as const;
    if (request.forDate !== r.checkOut) return { ok: false, error: "stale" } as const;
    const time = request.requestedTime.slice(0, 5);
    const note = input.note?.trim().slice(0, 500) || null;

    if (!input.approve) {
      await tx
        .update(schema.lateCheckoutRequests)
        .set({ status: "declined", decisionNote: note, decidedBy: input.actor.id, decidedAt: now, updatedAt: now })
        .where(eq(schema.lateCheckoutRequests.id, request.id));
      await audit(tx, r, input.actor, "late_checkout.declined", { time, note }, now);
      return { ok: true } as const;
    }

    // Lock the villa so a booking for that day cannot slip in while we decide.
    await tx.execute(sql`SELECT 1 FROM ${schema.units} WHERE id = ${r.unitId} FOR UPDATE`);
    const fit = await check(tx, loaded, time, now);
    if (fit.conflict) {
      return { ok: false, error: "conflict", codes: fit.nextArrival ? [fit.nextArrival.code] : [], latestAllowed: fit.latestAllowed } as const;
    }
    await tx
      .update(schema.lateCheckoutRequests)
      .set({ status: "approved", fee, decisionNote: note, decidedBy: input.actor.id, decidedAt: now, updatedAt: now })
      .where(eq(schema.lateCheckoutRequests.id, request.id));
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
    await audit(tx, r, input.actor, "late_checkout.approved", { time, fee, note }, now);
    return { ok: true } as const;
  });
}

/**
 * Withdraws a request or an approval (the guest changed plans). A fee that was
 * added comes off the bill; if it was already paid, it becomes a refund owed.
 */
export async function cancelLateCheckout(db: AnyDb | Tx, input: { reservationId: string; actor: Actor; now?: Date; reason?: string }): Promise<LateCheckoutResult> {
  const now = input.now ?? new Date();
  const run = async (tx: Tx) => {
    const loaded = await load(tx, input.reservationId, true);
    if (!loaded) return { ok: false, error: "not_found" } as const;
    const { r } = loaded;
    const request = await activeRequest(tx, r.id);
    if (!request) return { ok: false, error: "not_pending" } as const;
    await tx
      .update(schema.lateCheckoutRequests)
      .set({ status: "cancelled", decidedBy: input.actor.id ?? "guest", decidedAt: now, updatedAt: now })
      .where(eq(schema.lateCheckoutRequests.id, request.id));
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
    await audit(tx, r, input.actor, "late_checkout.cancelled", { time: request.requestedTime.slice(0, 5), fee: request.fee, reason: input.reason ?? null }, now);
    return { ok: true } as const;
  };
  return (db as AnyDb).transaction(run);
}

/*
 * Requests from the guest's booking page. The guest picks from the times
 * still possible right now (every 30 minutes after the standard check-out, up
 * to the next arrival's limit and never past GUEST_LATEST); nothing about the
 * other guest is shown. Staff still approve or decline, with an optional fee.
 * A guest can withdraw a request while it waits, not once it is decided.
 */

/** Latest departure a guest can ask for on their own; later needs the front desk. */
export const GUEST_LATEST = "18:00";
const GUEST_STEP_MINUTES = 30;

/** Times a guest may choose, given the limit now and (on the departure day) the time now. */
export function guestLateCheckoutTimes(input: { standardCheckOut: string; latestAllowed: string | null; nowTime: string | null }): string[] {
  const end = Math.min(toMinutes(input.latestAllowed ?? GUEST_LATEST), toMinutes(GUEST_LATEST));
  const times: string[] = [];
  for (let m = toMinutes(input.standardCheckOut) + GUEST_STEP_MINUTES; m <= end; m += GUEST_STEP_MINUTES) {
    if (input.nowTime === null || m > toMinutes(input.nowTime)) times.push(fromMinutes(m));
  }
  return times;
}

function timeIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
}

async function guestTimes(db: Executor, loaded: Loaded, now: Date) {
  const fit = await check(db, loaded, loaded.property.checkOutTime.slice(0, 5), now);
  const departureDay = loaded.r.checkOut === todayIn(loaded.property.timezone, now);
  return guestLateCheckoutTimes({
    standardCheckOut: fit.standardCheckOut,
    latestAllowed: fit.latestAllowed,
    nowTime: departureDay ? timeIn(loaded.property.timezone, now) : null,
  });
}

function guestCanAsk(loaded: Loaded, now: Date) {
  const { r, property } = loaded;
  return (r.status === "confirmed" || r.status === "in_house") && r.checkOut >= todayIn(property.timezone, now);
}

/** What the guest's booking page shows: the latest request for the current departure date, and the times on offer. */
export async function guestLateCheckout(db: AnyDb, reservationId: string, now: Date = new Date()) {
  const loaded = await load(db, reservationId, false);
  if (!loaded || !guestCanAsk(loaded, now)) return null;
  const [latest] = await db
    .select()
    .from(schema.lateCheckoutRequests)
    .where(and(eq(schema.lateCheckoutRequests.reservationId, reservationId), eq(schema.lateCheckoutRequests.forDate, loaded.r.checkOut)))
    .orderBy(desc(schema.lateCheckoutRequests.createdAt))
    .limit(1);
  return {
    standardCheckOut: loaded.property.checkOutTime.slice(0, 5),
    request: latest ? { status: latest.status, time: latest.requestedTime.slice(0, 5), fee: latest.fee } : null,
    times: await guestTimes(db, loaded, now),
  };
}

/** A guest asks to leave later, choosing one of the times still possible. */
export async function requestLateCheckoutAsGuest(
  db: AnyDb,
  input: { reservationId: string; time: string; note?: string | null; now?: Date },
): Promise<LateCheckoutResult> {
  const now = input.now ?? new Date();
  const actor: Actor = { type: "guest", id: null };
  return db.transaction(async (tx) => {
    const loaded = await load(tx, input.reservationId, true);
    if (!loaded) return { ok: false, error: "not_found" } as const;
    if (!guestCanAsk(loaded, now)) return { ok: false, error: "not_allowed" } as const;
    if (await activeRequest(tx, loaded.r.id)) return { ok: false, error: "already_requested" } as const;
    if (!(await guestTimes(tx, loaded, now)).includes(input.time)) return { ok: false, error: "time_unavailable" } as const;
    await tx.insert(schema.lateCheckoutRequests).values({
      reservationId: loaded.r.id,
      forDate: loaded.r.checkOut,
      requestedTime: input.time,
      note: input.note?.trim().slice(0, 500) || null,
      requestedBy: "guest",
      createdAt: now,
      updatedAt: now,
    });
    await audit(tx, loaded.r, actor, "late_checkout.requested", { time: input.time, forDate: loaded.r.checkOut, by: "guest" }, now);
    return { ok: true } as const;
  });
}

/** The guest withdraws a request that staff have not decided yet. */
export async function cancelLateCheckoutAsGuest(db: AnyDb, input: { reservationId: string; now?: Date }): Promise<LateCheckoutResult> {
  const request = await activeRequest(db, input.reservationId);
  if (!request || request.status !== "requested") return { ok: false, error: "not_pending" };
  return cancelLateCheckout(db, { reservationId: input.reservationId, actor: { type: "guest", id: null }, now: input.now, reason: "Withdrawn by guest" });
}
