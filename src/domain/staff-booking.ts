import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { createHold, loadUnitTypes, type HoldError, type HoldInput } from "./booking";
import { todayIn } from "./dates";
import { recordManualPayment, type ManualPaymentError, type PaymentMethod } from "./operations";
import { quoteStay } from "./pricing";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/*
 * Bookings taken by staff (phone, WhatsApp, walk-in, agents). Two ways:
 * - the money is already received (cash, transfer, card machine): it must
 *   cover the deposit due under the property's policy and confirms at once;
 * - the guest pays later through a payment link: the villa is held for the
 *   chosen time and confirmed by the payment, like a website booking.
 */

export const STAFF_SOURCES = ["direct", "walk_in", "agent"] as const;
export type StaffSource = (typeof STAFF_SOURCES)[number];

/** Hold times staff can choose for a payment link. */
export const LINK_HOLD_HOURS = [1, 24, 48] as const;

export type StaffBookingInput = Omit<HoldInput, "source" | "holdMinutes" | "candidateUnitIds" | "actorId"> & {
  source: StaffSource;
  /** A specific villa, or any free villa of the type. */
  unitId?: string | null;
  actorId: string;
  payment: { kind: "received"; amount: number; method: PaymentMethod; reference?: string | null } | { kind: "link"; holdHours: number };
};

export type StaffBookingError =
  | HoldError
  | { kind: "invalid_amount"; dueNow: number; total: number }
  | { kind: "payment"; error: ManualPaymentError };

export type StaffBookingResult =
  | { ok: true; reservation: typeof schema.reservations.$inferSelect; confirmed: boolean }
  | { ok: false; error: StaffBookingError };

export async function createStaffBooking(db: AnyDb, input: StaffBookingInput): Promise<StaffBookingResult> {
  const now = input.now ?? new Date();
  if (!(STAFF_SOURCES as readonly string[]).includes(input.source)) return { ok: false, error: { kind: "invalid_guest" } };
  const { payment } = input;

  if (payment.kind === "received") {
    // Check the amount against the price before holding anything.
    const loaded = (await loadUnitTypes(db, [input.unitTypeId])).get(input.unitTypeId);
    if (!loaded) return { ok: false, error: { kind: "unknown_unit_type" } };
    const quote = quoteStay(loaded.rules, { checkIn: input.checkIn, checkOut: input.checkOut, today: todayIn(loaded.property.timezone, now) });
    if (!quote.ok) return { ok: false, error: { kind: "quote", error: quote.error } };
    const { dueNow, total } = quote.quote;
    if (!Number.isSafeInteger(payment.amount) || payment.amount < dueNow || payment.amount > total) {
      return { ok: false, error: { kind: "invalid_amount", dueNow, total } };
    }
  } else if (!(LINK_HOLD_HOURS as readonly number[]).includes(payment.holdHours)) {
    return { ok: false, error: { kind: "invalid_guest" } };
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
  });
  if (!held.ok) return held;
  if (payment.kind === "link") return { ok: true, reservation: held.reservation, confirmed: false };

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
    await db.update(schema.reservations).set({ status: "expired", updatedAt: now }).where(eq(schema.reservations.id, held.reservation.id));
    return { ok: false, error: { kind: "payment", error: paid.error } };
  }
  const [reservation] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, held.reservation.id));
  return { ok: true, reservation, confirmed: paid.confirmed };
}
