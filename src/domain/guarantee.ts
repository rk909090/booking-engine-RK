import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { queueGuestMessage } from "./notifications";
import { isIsoDate, todayIn } from "./dates";
import type { Guarantee } from "./types";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Actor = { type: "staff"; id: string };
type Reservation = typeof schema.reservations.$inferSelect;

/*
 * Confirming a booking without the deposit (a guarantee): for trusted repeat
 * guests, agents and companies billed later, or guests paying on arrival.
 * Front office and branch managers may do it, always with a reason. The
 * deposit is then due by a date staff choose (from today up to the check-out
 * day, the check-in day by default). Past that date the booking is flagged
 * as overdue for staff to chase; it is never cancelled automatically.
 */

export type GuaranteeError = "not_found" | "not_hold" | "hold_expired" | "reason_required" | "invalid_pay_by" | "not_guaranteed";

/** Whether a pay-by date is allowed for a stay, given today's date at the property. */
export function validPayBy(payBy: string, today: string, checkOut: string): boolean {
  return isIsoDate(payBy) && payBy >= today && payBy <= checkOut;
}

/** The deposit a guaranteed booking still owes, or null when nothing is outstanding. */
export function guaranteeDue(
  r: Pick<Reservation, "status" | "guarantee" | "depositAmount" | "totalAmount" | "amountPaid">,
  today: string,
): { amount: number; payBy: string; overdue: boolean; terms: Guarantee } | null {
  if (!r.guarantee || (r.status !== "confirmed" && r.status !== "in_house")) return null;
  const amount = Math.min(r.depositAmount, r.totalAmount) - r.amountPaid;
  if (amount <= 0) return null;
  return { amount, payBy: r.guarantee.payBy, overdue: today > r.guarantee.payBy, terms: r.guarantee };
}

async function lock(db: AnyDb, reservationId: string, run: (tx: Parameters<Parameters<AnyDb["transaction"]>[0]>[0], r: Reservation, today: string) => Promise<{ ok: true } | { ok: false; error: GuaranteeError }>, now: Date) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ r: schema.reservations, timezone: schema.properties.timezone })
      .from(schema.reservations)
      .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
      .where(eq(schema.reservations.id, reservationId))
      .for("update", { of: schema.reservations });
    if (!row) return { ok: false, error: "not_found" } as const;
    return run(tx, row.r, todayIn(row.timezone, now));
  });
}

/**
 * Confirms a live hold without payment. Payment links already sent stay open
 * until they expire, so the guest can still pay the deposit online.
 */
export async function confirmWithoutDeposit(
  db: AnyDb,
  input: { reservationId: string; reason: string; payBy: string; actor: Actor; now?: Date },
): Promise<{ ok: true } | { ok: false; error: GuaranteeError }> {
  const now = input.now ?? new Date();
  const reason = input.reason.trim().slice(0, 300);
  if (!reason) return { ok: false, error: "reason_required" };
  return lock(
    db,
    input.reservationId,
    async (tx, r, today) => {
      if (r.status !== "hold") return { ok: false, error: "not_hold" };
      if (!r.holdExpiresAt || r.holdExpiresAt <= now) return { ok: false, error: "hold_expired" };
      if (!validPayBy(input.payBy, today, r.checkOut)) return { ok: false, error: "invalid_pay_by" };
      const guarantee: Guarantee = { reason, payBy: input.payBy, givenBy: input.actor.id, givenAt: now.toISOString() };
      await tx.update(schema.reservations).set({ status: "confirmed", holdExpiresAt: null, guarantee, updatedAt: now }).where(eq(schema.reservations.id, r.id));
      await tx.insert(schema.auditEvents).values({
        actorType: input.actor.type,
        actorId: input.actor.id,
        propertyId: r.propertyId,
        entityType: "reservation",
        entityId: r.id,
        action: "reservation.guaranteed",
        before: { status: r.status },
        after: { status: "confirmed", reason, payBy: input.payBy, deposit: r.depositAmount },
        occurredAt: now,
      });
      await queueGuestMessage(tx, { reservationId: r.id, kind: "booking_confirmed", payload: { payBy: input.payBy, depositDue: r.depositAmount }, now });
      return { ok: true };
    },
    now,
  );
}

/** Moves the deposit deadline of a guaranteed booking that still owes it. */
export async function changePayBy(
  db: AnyDb,
  input: { reservationId: string; payBy: string; actor: Actor; now?: Date },
): Promise<{ ok: true } | { ok: false; error: GuaranteeError }> {
  const now = input.now ?? new Date();
  return lock(
    db,
    input.reservationId,
    async (tx, r, today) => {
      if (!r.guarantee || !guaranteeDue(r, today)) return { ok: false, error: "not_guaranteed" };
      if (!validPayBy(input.payBy, today, r.checkOut)) return { ok: false, error: "invalid_pay_by" };
      await tx
        .update(schema.reservations)
        .set({ guarantee: { ...r.guarantee, payBy: input.payBy }, updatedAt: now })
        .where(eq(schema.reservations.id, r.id));
      await tx.insert(schema.auditEvents).values({
        actorType: input.actor.type,
        actorId: input.actor.id,
        propertyId: r.propertyId,
        entityType: "reservation",
        entityId: r.id,
        action: "reservation.pay_by_changed",
        before: { payBy: r.guarantee.payBy },
        after: { payBy: input.payBy },
        occurredAt: now,
      });
      return { ok: true };
    },
    now,
  );
}
