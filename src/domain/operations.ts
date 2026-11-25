import { randomBytes } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { addDays, todayIn } from "./dates";
import { balanceDue } from "./pricing";
import { openBlockToday, recordState, unitState, type HkState } from "./housekeeping";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Tx = Parameters<Parameters<AnyDb["transaction"]>[0]>[0];

/*
 * Front-desk operations on a reservation. `stayActions` is a pure function:
 * the server uses it to enforce the rules and the UI uses the same result to
 * disable buttons with the reason, so they can never disagree.
 */

export type BlockReason =
  | "not_confirmed"
  | "in_house"
  | "before_arrival"
  | "after_departure"
  | "unit_occupied"
  | "unit_not_ready"
  | "unit_blocked"
  | "not_in_house"
  | "arrival_not_passed"
  | "use_no_show"
  | "final_status"
  | "no_refund_due";

export type ActionState = { allowed: true } | { allowed: false; reason: BlockReason };

export type StayFacts = {
  status: (typeof schema.reservationStatus.enumValues)[number];
  checkIn: string;
  checkOut: string;
  /** Today's date at the property. */
  today: string;
  /** Another reservation is currently in house in the same unit. */
  unitOccupiedByOther: boolean;
  refundOutstanding: number;
  /** Recorded cleaning state of the unit. */
  unitState: HkState;
  /** An open maintenance block covers today. */
  unitBlockedToday: boolean;
};

const ok: ActionState = { allowed: true };
const no = (reason: BlockReason): ActionState => ({ allowed: false, reason });

export function stayActions(f: StayFacts) {
  const final = ["checked_out", "cancelled", "no_show", "expired"].includes(f.status);
  // Why an action that needs a confirmed booking is not available.
  const notConfirmed = no(final ? "final_status" : f.status === "in_house" ? "in_house" : "not_confirmed");
  return {
    checkIn:
      f.status !== "confirmed"
        ? notConfirmed
        : f.today < f.checkIn
          ? no("before_arrival")
          : f.today >= f.checkOut
            ? no("after_departure")
            : f.unitOccupiedByOther
              ? no("unit_occupied")
              : f.unitBlockedToday
                ? no("unit_blocked")
                : f.unitState !== "ready"
                  ? no("unit_not_ready")
                  : ok,
    checkOut: f.status === "in_house" ? ok : no(final ? "final_status" : "not_in_house"),
    noShow:
      f.status !== "confirmed" ? notConfirmed : f.today <= f.checkIn ? no("arrival_not_passed") : ok,
    cancel:
      f.status === "hold"
        ? ok
        : f.status !== "confirmed"
          ? notConfirmed
          : f.today > f.checkIn
            ? no("use_no_show")
            : ok,
    refund: f.refundOutstanding > 0 ? ok : no("no_refund_due"),
  };
}

export type OperationError = BlockReason | "not_found" | "balance_outstanding" | "invalid_amount";
export type OperationResult = { ok: true } | { ok: false; error: OperationError };

type Actor = { type: "staff"; id: string };

async function lockReservation(tx: Tx, reservationId: string) {
  const [row] = await tx
    .select({ r: schema.reservations, timezone: schema.properties.timezone })
    .from(schema.reservations)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .where(eq(schema.reservations.id, reservationId))
    .for("update", { of: schema.reservations });
  return row ?? null;
}

/** Refund owed minus refunds already paid out. */
export async function refundOutstanding(db: AnyDb | Tx, reservationId: string, refundAmount: number | null) {
  if (!refundAmount) return 0;
  const [paid] = await db
    .select({ sum: sql<number>`coalesce(sum(${schema.payments.amount}), 0)::bigint` })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.reservationId, reservationId),
        eq(schema.payments.purpose, "refund"),
        eq(schema.payments.status, "paid"),
      ),
    );
  return Math.max(0, refundAmount - Number(paid.sum));
}

/** Facts needed by stayActions, read from the database. */
export async function loadStayFacts(db: AnyDb | Tx, r: typeof schema.reservations.$inferSelect, timezone: string, now: Date) {
  const [other] = await db
    .select({ id: schema.reservations.id })
    .from(schema.reservations)
    .where(
      and(
        eq(schema.reservations.unitId, r.unitId),
        eq(schema.reservations.status, "in_house"),
        ne(schema.reservations.id, r.id),
      ),
    )
    .limit(1);
  const today = todayIn(timezone, now);
  return {
    status: r.status,
    checkIn: r.checkIn,
    checkOut: r.checkOut,
    today,
    unitOccupiedByOther: Boolean(other),
    refundOutstanding: await refundOutstanding(db, r.id, r.refundAmount),
    unitState: await unitState(db, r.unitId),
    unitBlockedToday: Boolean(await openBlockToday(db, r.unitId, today)),
  } satisfies StayFacts;
}

async function audit(tx: Tx, r: typeof schema.reservations.$inferSelect, actor: Actor, action: string, before: object, after: object, now: Date) {
  await tx.insert(schema.auditEvents).values({
    actorType: actor.type,
    actorId: actor.id,
    propertyId: r.propertyId,
    entityType: "reservation",
    entityId: r.id,
    action,
    before,
    after,
    occurredAt: now,
  });
}

export async function checkIn(db: AnyDb, input: { reservationId: string; actor: Actor; now?: Date }): Promise<OperationResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const row = await lockReservation(tx, input.reservationId);
    if (!row) return { ok: false, error: "not_found" } as const;
    const state = stayActions(await loadStayFacts(tx, row.r, row.timezone, now)).checkIn;
    if (!state.allowed) return { ok: false, error: state.reason } as const;
    await tx.update(schema.reservations).set({ status: "in_house", updatedAt: now }).where(eq(schema.reservations.id, row.r.id));
    await audit(tx, row.r, input.actor, "reservation.checked_in", { status: row.r.status }, { status: "in_house" }, now);
    return { ok: true } as const;
  });
}

/**
 * Checks a guest out. An unpaid balance must be acknowledged explicitly
 * (settled outside the app). Leaving early shortens the stay so the remaining
 * nights become bookable again.
 */
export async function checkOut(
  db: AnyDb,
  input: { reservationId: string; actor: Actor; acknowledgeBalance?: boolean; now?: Date },
): Promise<OperationResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const row = await lockReservation(tx, input.reservationId);
    if (!row) return { ok: false, error: "not_found" } as const;
    const facts = await loadStayFacts(tx, row.r, row.timezone, now);
    const state = stayActions(facts).checkOut;
    if (!state.allowed) return { ok: false, error: state.reason } as const;
    const balance = balanceDue(row.r);
    if (balance > 0 && !input.acknowledgeBalance) return { ok: false, error: "balance_outstanding" } as const;

    const earliest = addDays(row.r.checkIn, 1);
    const newCheckOut = facts.today < row.r.checkOut ? (facts.today > row.r.checkIn ? facts.today : earliest) : row.r.checkOut;
    await tx
      .update(schema.reservations)
      .set({ status: "checked_out", checkOut: newCheckOut, updatedAt: now })
      .where(eq(schema.reservations.id, row.r.id));
    // The villa needs cleaning before the next guest.
    await recordState(tx, row.r.unitId, await unitState(tx, row.r.unitId), "dirty", input.actor, `Check-out ${row.r.code}`, now);
    await audit(
      tx,
      row.r,
      input.actor,
      "reservation.checked_out",
      { status: row.r.status, checkOut: row.r.checkOut },
      { status: "checked_out", checkOut: newCheckOut, balanceAcknowledged: balance > 0 ? balance : 0 },
      now,
    );
    return { ok: true } as const;
  });
}

/** Records that a confirmed guest did not arrive. Payments are kept; the nights are released. */
export async function markNoShow(db: AnyDb, input: { reservationId: string; actor: Actor; now?: Date }): Promise<OperationResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const row = await lockReservation(tx, input.reservationId);
    if (!row) return { ok: false, error: "not_found" } as const;
    const state = stayActions(await loadStayFacts(tx, row.r, row.timezone, now)).noShow;
    if (!state.allowed) return { ok: false, error: state.reason } as const;
    await tx.update(schema.reservations).set({ status: "no_show", updatedAt: now }).where(eq(schema.reservations.id, row.r.id));
    await audit(tx, row.r, input.actor, "reservation.no_show", { status: row.r.status }, { status: "no_show" }, now);
    return { ok: true } as const;
  });
}

/** Records a refund paid outside the app (for example a bank transfer). */
export async function recordRefundPayout(
  db: AnyDb,
  input: { reservationId: string; amount: number; reference: string; actor: Actor; now?: Date },
): Promise<OperationResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const row = await lockReservation(tx, input.reservationId);
    if (!row) return { ok: false, error: "not_found" } as const;
    const outstanding = await refundOutstanding(tx, row.r.id, row.r.refundAmount);
    if (outstanding <= 0) return { ok: false, error: "no_refund_due" } as const;
    if (!Number.isInteger(input.amount) || input.amount <= 0 || input.amount > outstanding) {
      return { ok: false, error: "invalid_amount" } as const;
    }
    const [payment] = await tx
      .insert(schema.payments)
      .values({
        reservationId: row.r.id,
        provider: "manual",
        providerRef: `manual_${randomBytes(9).toString("base64url")}`,
        purpose: "refund",
        amount: input.amount,
        currency: row.r.currency,
        status: "paid",
        paidAt: now,
        raw: { reference: input.reference.trim().slice(0, 200), recordedBy: input.actor.id },
      })
      .returning({ id: schema.payments.id });
    await audit(tx, row.r, input.actor, "refund.paid_out", {}, { paymentId: payment.id, amount: input.amount, reference: input.reference.trim() }, now);
    return { ok: true } as const;
  });
}
