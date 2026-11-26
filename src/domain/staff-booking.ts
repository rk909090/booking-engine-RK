import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { createHold, loadUnitTypes, type HoldError, type HoldInput } from "./booking";
import { todayIn } from "./dates";
import { recordManualPayment, type ManualPaymentError, type PaymentMethod } from "./operations";
import { discountLimitBp, withinLimit } from "./discount";
import { confirmWithoutDeposit, validPayBy, type GuaranteeError } from "./guarantee";
import { checkPromo } from "./promos";
import { quoteStay, validDiscount } from "./pricing";
import type { Discount, DiscountTerms } from "./types";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/*
 * Bookings taken by staff (phone, WhatsApp, walk-in, agents). Two ways:
 * - the money is already received (cash, transfer, card machine): it must
 *   cover the deposit due under the property's policy and confirms at once;
 * - the guest pays later through a payment link: the villa is held for the
 *   chosen time and confirmed by the payment, like a website booking;
 * - confirmed without the deposit (a guarantee, see guarantee.ts): a reason
 *   and the date the deposit is due by are required.
 */

export const STAFF_SOURCES = ["direct", "walk_in", "agent"] as const;
export type StaffSource = (typeof STAFF_SOURCES)[number];

/** Hold times staff can choose for a payment link. */
export const LINK_HOLD_HOURS = [1, 24, 48] as const;

export type StaffBookingInput = Omit<HoldInput, "source" | "holdMinutes" | "candidateUnitIds" | "actorId" | "discount"> & {
  source: StaffSource;
  /** A specific villa, or any free villa of the type. */
  unitId?: string | null;
  actorId: string;
  /** The staff member's role, which sets their discount ceiling. */
  role: string;
  discount?: (Discount & { reason: string }) | null;
  payment:
    | { kind: "received"; amount: number; method: PaymentMethod; reference?: string | null }
    | { kind: "link"; holdHours: number }
    | { kind: "guarantee"; reason: string; payBy: string };
};

export type StaffBookingError =
  | HoldError
  | { kind: "invalid_amount"; dueNow: number; total: number }
  | { kind: "invalid_discount" }
  | { kind: "smaller_than_offer" }
  | { kind: "over_limit"; limitBp: number }
  | { kind: "payment"; error: ManualPaymentError }
  | { kind: "guarantee"; error: GuaranteeError };

export type StaffBookingResult =
  | { ok: true; reservation: typeof schema.reservations.$inferSelect; confirmed: boolean }
  | { ok: false; error: StaffBookingError };

export async function createStaffBooking(db: AnyDb, input: StaffBookingInput): Promise<StaffBookingResult> {
  const now = input.now ?? new Date();
  if (!(STAFF_SOURCES as readonly string[]).includes(input.source)) return { ok: false, error: { kind: "invalid_guest" } };
  const { payment } = input;
  if (payment.kind === "link" && !(LINK_HOLD_HOURS as readonly number[]).includes(payment.holdHours)) {
    return { ok: false, error: { kind: "invalid_guest" } };
  }

  let discount: DiscountTerms | null = null;
  if (input.discount) {
    const { reason, ...terms } = input.discount;
    if (!validDiscount(terms) || !reason.trim()) return { ok: false, error: { kind: "invalid_discount" } };
    discount = { ...terms, reason: reason.trim().slice(0, 300), givenBy: input.actorId, givenAt: now.toISOString() };
  }

  // Check the price, the discount ceiling and the amount before holding anything.
  const loaded = (await loadUnitTypes(db, [input.unitTypeId])).get(input.unitTypeId);
  if (!loaded) return { ok: false, error: { kind: "unknown_unit_type" } };
  const today = todayIn(loaded.property.timezone, now);
  let promo = null;
  if (input.promoCode?.trim()) {
    const checked = await checkPromo(db, { propertyId: loaded.property.id, unitTypeId: input.unitTypeId, code: input.promoCode, checkIn: input.checkIn, checkOut: input.checkOut, today, now });
    if (!checked.ok) return { ok: false, error: { kind: "promo", error: checked.error } };
    promo = checked.promo;
  }
  const quote = quoteStay(loaded.rules, { checkIn: input.checkIn, checkOut: input.checkOut, today }, discount, {
    plan: input.ratePlan ?? "standard",
    guests: input.adults + input.children,
    promo,
  });
  if (!quote.ok) return { ok: false, error: { kind: "quote", error: quote.error } };
  if (discount) {
    // Only one discount applies besides the plan: a staff discount must beat the best offer.
    const staffOff = quote.quote.staffDiscount ?? 0;
    if (staffOff === 0) return { ok: false, error: { kind: "smaller_than_offer" } };
    const limitBp = discountLimitBp(loaded.property, input.role);
    if (!withinLimit(staffOff, quote.quote.subtotal, limitBp)) return { ok: false, error: { kind: "over_limit", limitBp } };
  }
  if (payment.kind === "guarantee") {
    if (!payment.reason.trim()) return { ok: false, error: { kind: "guarantee", error: "reason_required" } };
    if (!validPayBy(payment.payBy, todayIn(loaded.property.timezone, now), input.checkOut)) {
      return { ok: false, error: { kind: "guarantee", error: "invalid_pay_by" } };
    }
  }
  if (payment.kind === "received") {
    const { dueNow, total } = quote.quote;
    if (!Number.isSafeInteger(payment.amount) || payment.amount < dueNow || payment.amount > total) {
      return { ok: false, error: { kind: "invalid_amount", dueNow, total } };
    }
  }

  if (input.unitId) {
    const [unit] = await db
      .select({ unitTypeId: schema.units.unitTypeId, isActive: schema.units.isActive })
      .from(schema.units)
      .where(eq(schema.units.id, input.unitId));
    if (!unit || unit.unitTypeId !== input.unitTypeId || !unit.isActive) return { ok: false, error: { kind: "sold_out" } };
  }

  const held = await createHold(db, {
    ...input,
    now,
    candidateUnitIds: input.unitId ? [input.unitId] : undefined,
    holdMinutes: payment.kind === "link" ? payment.holdHours * 60 : undefined,
    actorId: input.actorId,
    discount,
  });
  if (!held.ok) return held;
  if (payment.kind === "link") return { ok: true, reservation: held.reservation, confirmed: false };

  const release = () => db.update(schema.reservations).set({ status: "expired", updatedAt: now }).where(eq(schema.reservations.id, held.reservation.id));
  if (payment.kind === "guarantee") {
    const confirmed = await confirmWithoutDeposit(db, {
      reservationId: held.reservation.id,
      reason: payment.reason,
      payBy: payment.payBy,
      actor: { type: "staff", id: input.actorId },
      now,
    });
    if (!confirmed.ok) {
      await release();
      return { ok: false, error: { kind: "guarantee", error: confirmed.error } };
    }
    const [reservation] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, held.reservation.id));
    return { ok: true, reservation, confirmed: true };
  }

  const paid = await recordManualPayment(db, {
    reservationId: held.reservation.id,
    amount: payment.amount,
    method: payment.method,
    reference: payment.reference,
    actor: { type: "staff", id: input.actorId },
    now,
  });
  if (!paid.ok) {
    // Not expected after the checks above; release the villa rather than leave a stray hold.
    await release();
    return { ok: false, error: { kind: "payment", error: paid.error } };
  }
  const [reservation] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, held.reservation.id));
  return { ok: true, reservation, confirmed: paid.confirmed };
}
