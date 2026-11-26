import { and, asc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { queueGuestMessage } from "./notifications";
import type { PriceSnapshot } from "@/domain/types";
import { EXCLUSION_VIOLATION, loadUnitTypes, sqlState, unitIsFree } from "./booking";
import { addDays, diffDays, isIsoDate, todayIn } from "./dates";
import { minStayFor, repriceStay } from "./pricing";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Tx = Parameters<Parameters<AnyDb["transaction"]>[0]>[0];
type Executor = AnyDb | Tx;
type Reservation = typeof schema.reservations.$inferSelect;

/*
 * Changing the dates of a booking and moving it to another villa of the same
 * type. Staff first see a preview (new price, difference, what is owed) and
 * then confirm it; the confirmation is re-checked under locks and refused if
 * the price moved in between.
 *
 * Rules:
 * - Confirmed bookings: new dates from today on, minimum and maximum stay as
 *   for a new booking, any free villa of the same type.
 * - Guests in house: only the departure date changes (extend or shorten,
 *   leaving tomorrow at the earliest; leaving today is a check-out), and the
 *   villa stays the same.
 * - Nights the booking already had keep their price; added nights use today's
 *   rates. Paying back an overpayment is recorded as a refund owed.
 */

export type StayChangeError =
  | "not_found"
  | "not_confirmed"
  | "final_status"
  | "invalid_dates"
  | "check_in_in_past"
  | "check_in_fixed"
  | "check_out_too_early"
  | "min_stay"
  | "max_stay"
  | "unit_fixed"
  | "unit_not_eligible"
  | "no_change"
  | "dates_unavailable"
  | "unit_blocked"
  | "channel_booked"
  | "price_changed";

export type StayChangeRequest = { checkIn: string; checkOut: string; unitId: string };

export type StayChangePlan = StayChangeRequest & {
  unitCode: string;
  /** The nights. */
  price: PriceSnapshot;
  /** Charges on top of the nights after the change. */
  extras: number;
  /** New total: nights plus extras. */
  total: number;
  /** A late check-out for the old departure date is withdrawn (and its fee removed). */
  lateCheckoutCancelled: boolean;
  /** An early check-in for the old arrival date is withdrawn (and its fee removed). */
  earlyCheckinCancelled: boolean;
  previousTotal: number;
  /** New total minus old total; negative when the stay got cheaper. */
  difference: number;
  /** Still to pay after the change. */
  balanceAfter: number;
  /** Refund owed after the change and not yet paid out. */
  refundOutstandingAfter: number;
  /** The new value of reservations.refund_amount (total refund owed, paid or not). */
  refundAmount: number | null;
  balanceDueDate: string | null;
  moved: boolean;
};

export type StayChangeFailure = {
  ok: false;
  error: StayChangeError;
  /** Bookings in the way (dates_unavailable). */
  codes?: string[];
  minNights?: number;
  maxNights?: number;
  /** Other villas of the same type free for the requested dates. */
  alternatives?: Array<{ id: string; code: string }>;
};

export type StayChangeResult = { ok: true; plan: StayChangePlan } | StayChangeFailure;

/** Whether the booking can be changed at all, and whether it can change villa. */
export function changeability(status: Reservation["status"]): {
  dates: { allowed: true } | { allowed: false; reason: "not_confirmed" | "final_status" };
  unit: { allowed: true } | { allowed: false; reason: "not_confirmed" | "final_status" | "unit_fixed" };
} {
  if (status === "confirmed") return { dates: { allowed: true }, unit: { allowed: true } };
  if (status === "in_house") return { dates: { allowed: true }, unit: { allowed: false, reason: "unit_fixed" } };
  const reason = status === "hold" ? "not_confirmed" : "final_status";
  return { dates: { allowed: false, reason }, unit: { allowed: false, reason } };
}

/** Refunds already paid out for a booking. */
export async function refundsPaid(db: Executor, reservationId: string): Promise<number> {
  const [row] = await db
    .select({ sum: sql<number>`coalesce(sum(${schema.payments.amount}), 0)::bigint` })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.reservationId, reservationId),
        eq(schema.payments.purpose, "refund"),
        eq(schema.payments.status, "paid"),
      ),
    );
  return Number(row.sum);
}

async function conflictsOn(db: Executor, r: Reservation, unitId: string, checkIn: string, checkOut: string, now: Date) {
  const overlaps = (start: unknown, end: unknown) =>
    sql`daterange(${start}, ${end}, '[)') && daterange(${checkIn}::date, ${checkOut}::date, '[)')`;
  const [bookings, blocks, channel] = await Promise.all([
    db
      .select({ code: schema.reservations.code })
      .from(schema.reservations)
      .where(
        and(
          eq(schema.reservations.unitId, unitId),
          ne(schema.reservations.id, r.id),
          overlaps(schema.reservations.checkIn, schema.reservations.checkOut),
          sql`(${schema.reservations.status} IN ('confirmed', 'in_house', 'checked_out')
            OR (${schema.reservations.status} = 'hold' AND ${schema.reservations.holdExpiresAt} > ${now.toISOString()}::timestamptz))`,
        ),
      )
      .orderBy(asc(schema.reservations.checkIn)),
    db
      .select({ id: schema.unitBlocks.id })
      .from(schema.unitBlocks)
      .where(
        and(
          eq(schema.unitBlocks.unitId, unitId),
          eq(schema.unitBlocks.status, "open"),
          overlaps(schema.unitBlocks.startDate, schema.unitBlocks.endDate),
        ),
      )
      .limit(1),
    db
      .select({ id: schema.icalEvents.id })
      .from(schema.icalEvents)
      .where(and(eq(schema.icalEvents.unitId, unitId), overlaps(schema.icalEvents.startDate, schema.icalEvents.endDate)))
      .limit(1),
  ]);
  return { codes: bookings.map((b) => b.code), blocked: blocks.length > 0, channel: channel.length > 0 };
}

async function alternativesFor(db: Executor, r: Reservation, checkIn: string, checkOut: string, now: Date) {
  return db
    .select({ id: schema.units.id, code: schema.units.code })
    .from(schema.units)
    .where(
      and(
        eq(schema.units.unitTypeId, r.unitTypeId),
        eq(schema.units.isActive, true),
        ne(schema.units.id, r.unitId),
        unitIsFree(checkIn, checkOut, now),
      ),
    )
    .orderBy(asc(schema.units.code));
}

async function evaluate(db: Executor, r: Reservation, timezone: string, req: StayChangeRequest, now: Date): Promise<StayChangeResult> {
  const allowed = changeability(r.status);
  if (!allowed.dates.allowed) return { ok: false, error: allowed.dates.reason };
  const today = todayIn(timezone, now);
  const { checkIn, checkOut, unitId } = req;
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut) || checkOut <= checkIn) return { ok: false, error: "invalid_dates" };
  const moved = unitId !== r.unitId;

  if (r.status === "in_house") {
    if (checkIn !== r.checkIn) return { ok: false, error: "check_in_fixed" };
    if (moved) return { ok: false, error: "unit_fixed" };
    if (checkOut <= today) return { ok: false, error: "check_out_too_early" };
  } else if (checkIn < today) {
    return { ok: false, error: "check_in_in_past" };
  }
  if (checkIn === r.checkIn && checkOut === r.checkOut && !moved) return { ok: false, error: "no_change" };

  const loaded = (await loadUnitTypes(db, [r.unitTypeId])).get(r.unitTypeId);
  if (!loaded) return { ok: false, error: "not_found" };
  const nights = diffDays(checkIn, checkOut);
  if (r.status === "confirmed") {
    const minNights = minStayFor(loaded.rules, checkIn);
    if (nights < minNights) return { ok: false, error: "min_stay", minNights };
  }
  if (nights > loaded.rules.maxStayNights) return { ok: false, error: "max_stay", maxNights: loaded.rules.maxStayNights };

  const [unit] = await db
    .select({ id: schema.units.id, code: schema.units.code, unitTypeId: schema.units.unitTypeId, isActive: schema.units.isActive })
    .from(schema.units)
    .where(eq(schema.units.id, unitId));
  if (!unit || unit.unitTypeId !== r.unitTypeId || (moved && !unit.isActive)) return { ok: false, error: "unit_not_eligible" };

  const conflicts = await conflictsOn(db, r, unitId, checkIn, checkOut, now);
  if (conflicts.codes.length > 0 || conflicts.blocked || conflicts.channel) {
    return {
      ok: false,
      error: conflicts.codes.length > 0 ? "dates_unavailable" : conflicts.blocked ? "unit_blocked" : "channel_booked",
      codes: conflicts.codes,
      alternatives: r.status === "confirmed" ? await alternativesFor(db, r, checkIn, checkOut, now) : [],
    };
  }

  // A discount given as a share follows the new nights; a fixed amount stays (capped at the new nights' price).
  // The plan and offers saved with the booking are re-applied (an offer whose minimum nights is no longer met drops out).
  const price = repriceStay(loaded.rules, r.priceSnapshot ?? null, checkIn, checkOut, r.discount ?? null, r.pricingTerms ?? null);
  // A late check-out belongs to the old departure date.
  const [late] =
    checkOut !== r.checkOut
      ? await db
          .select({ status: schema.lateCheckoutRequests.status, fee: schema.lateCheckoutRequests.fee })
          .from(schema.lateCheckoutRequests)
          .where(and(eq(schema.lateCheckoutRequests.reservationId, r.id), inArray(schema.lateCheckoutRequests.status, ["requested", "approved"])))
          .limit(1)
      : [];
  const [early] =
    checkIn !== r.checkIn
      ? await db
          .select({ status: schema.earlyCheckinRequests.status, fee: schema.earlyCheckinRequests.fee })
          .from(schema.earlyCheckinRequests)
          .where(and(eq(schema.earlyCheckinRequests.reservationId, r.id), inArray(schema.earlyCheckinRequests.status, ["requested", "approved"])))
          .limit(1)
      : [];
  const extras = r.extrasAmount - (late?.status === "approved" ? late.fee : 0) - (early?.status === "approved" ? early.fee : 0);
  const total = price.total + extras;
  const paidOut = await refundsPaid(db, r.id);
  // A refund already paid out cannot be taken back, so it stays owed-and-paid.
  const refundAmount = Math.max(paidOut, r.amountPaid - total);
  const balanceAfter = total - r.amountPaid + refundAmount;
  const balanceDueDays = r.policySnapshot?.balanceDueDays ?? loaded.property.balanceDueDays;
  // Close to arrival (or in house) the usual due date has passed: it is due now.
  const usualDue = addDays(checkIn, -balanceDueDays);
  const dueDate = usualDue < today ? today : usualDue;
  return {
    ok: true,
    plan: {
      checkIn,
      checkOut,
      unitId,
      unitCode: unit.code,
      price,
      extras,
      total,
      lateCheckoutCancelled: Boolean(late),
      earlyCheckinCancelled: Boolean(early),
      previousTotal: r.totalAmount,
      difference: total - r.totalAmount,
      balanceAfter,
      refundOutstandingAfter: refundAmount - paidOut,
      refundAmount: refundAmount > 0 ? refundAmount : null,
      balanceDueDate: balanceAfter > 0 ? dueDate : null,
      moved,
    },
  };
}

async function loadReservation(db: Executor, reservationId: string, lock: boolean) {
  const query = db
    .select({ r: schema.reservations, timezone: schema.properties.timezone })
    .from(schema.reservations)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .where(eq(schema.reservations.id, reservationId));
  const [row] = lock ? await query.for("update", { of: schema.reservations }) : await query;
  return row ?? null;
}

/** What a change would do, without changing anything. */
export async function previewStayChange(
  db: AnyDb,
  input: StayChangeRequest & { reservationId: string; now?: Date },
): Promise<StayChangeResult> {
  const row = await loadReservation(db, input.reservationId, false);
  if (!row) return { ok: false, error: "not_found" };
  return evaluate(db, row.r, row.timezone, input, input.now ?? new Date());
}

/**
 * Applies a change previewed for `expectedTotal`. Everything is checked again
 * under locks; a different price means the rates changed since the preview.
 */
export async function applyStayChange(
  db: AnyDb,
  input: StayChangeRequest & { reservationId: string; expectedTotal: number; actor: { type: "staff"; id: string }; now?: Date },
): Promise<StayChangeResult> {
  const now = input.now ?? new Date();
  try {
    return await db.transaction(async (tx) => {
      const row = await loadReservation(tx, input.reservationId, true);
      if (!row) return { ok: false, error: "not_found" } as const;
      const r = row.r;
      // Lock the target villa so a block or booking cannot slip in, and release
      // its lapsed holds, which still count for the overlap guard.
      await tx.execute(sql`SELECT 1 FROM ${schema.units} WHERE id = ${input.unitId} FOR UPDATE`);
      await tx
        .update(schema.reservations)
        .set({ status: "expired", updatedAt: now })
        .where(
          and(
            eq(schema.reservations.unitId, input.unitId),
            eq(schema.reservations.status, "hold"),
            lte(schema.reservations.holdExpiresAt, now),
          ),
        );

      const result = await evaluate(tx, r, row.timezone, input, now);
      if (!result.ok) return result;
      const plan = result.plan;
      if (plan.total !== input.expectedTotal) return { ok: false, error: "price_changed" } as const;

      await tx
        .update(schema.reservations)
        .set({
          checkIn: plan.checkIn,
          checkOut: plan.checkOut,
          unitId: plan.unitId,
          totalAmount: plan.total,
          extrasAmount: plan.extras,
          subtotalAmount: plan.price.subtotal,
          discountAmount: plan.price.discount ?? 0,
          breakfastAmount: plan.price.breakfast ?? 0,
          serviceAmount: plan.price.service,
          taxAmount: plan.price.tax,
          priceSnapshot: plan.price,
          balanceDueDate: plan.balanceDueDate,
          refundAmount: plan.refundAmount,
          updatedAt: now,
        })
        .where(eq(schema.reservations.id, r.id));

      const [fromUnit] = await tx.select({ code: schema.units.code }).from(schema.units).where(eq(schema.units.id, r.unitId));
      await tx.insert(schema.auditEvents).values({
        actorType: input.actor.type,
        actorId: input.actor.id,
        propertyId: r.propertyId,
        entityType: "reservation",
        entityId: r.id,
        action: plan.moved && plan.checkIn === r.checkIn && plan.checkOut === r.checkOut ? "reservation.moved" : "reservation.modified",
        before: { checkIn: r.checkIn, checkOut: r.checkOut, unitId: r.unitId, unitCode: fromUnit?.code, total: r.totalAmount },
        after: {
          checkIn: plan.checkIn,
          checkOut: plan.checkOut,
          unitId: plan.unitId,
          unitCode: plan.unitCode,
          total: plan.total,
          difference: plan.difference,
          lateCheckoutCancelled: plan.lateCheckoutCancelled,
          earlyCheckinCancelled: plan.earlyCheckinCancelled,
          refundOutstanding: plan.refundOutstandingAfter,
        },
        occurredAt: now,
      });

      if (plan.lateCheckoutCancelled) {
        await tx
          .update(schema.lateCheckoutRequests)
          .set({ status: "cancelled", decidedBy: input.actor.id, decidedAt: now, decisionNote: "Departure date changed", updatedAt: now })
          .where(and(eq(schema.lateCheckoutRequests.reservationId, r.id), inArray(schema.lateCheckoutRequests.status, ["requested", "approved"])));
      }

      if (plan.earlyCheckinCancelled) {
        await tx
          .update(schema.earlyCheckinRequests)
          .set({ status: "cancelled", decidedBy: input.actor.id, decidedAt: now, decisionNote: "Arrival date changed", updatedAt: now })
          .where(and(eq(schema.earlyCheckinRequests.reservationId, r.id), inArray(schema.earlyCheckinRequests.status, ["requested", "approved"])));
      }

      if (plan.checkIn !== r.checkIn || plan.checkOut !== r.checkOut || plan.difference !== 0) {
        await queueGuestMessage(tx, { reservationId: r.id, kind: "booking_modified", payload: { difference: plan.difference }, now });
      }
      return result;
    });
  } catch (error) {
    // Someone booked the villa between our check and the update.
    if (sqlState(error) === EXCLUSION_VIOLATION) return { ok: false, error: "dates_unavailable", codes: [] };
    throw error;
  }
}
