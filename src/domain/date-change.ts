import { and, desc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { applyStayChange, previewStayChange, type StayChangeError } from "./modify";
import { queueGuestMessage } from "./notifications";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Actor = { type: "staff"; id: string };

/*
 * Date changes asked for by the guest from their booking page (decided with
 * the owner, 26 Nov 2026: the guest asks, staff approve). The guest picks new
 * dates and sees an estimate when their villa is free; staff then apply it
 * with the usual date-change rules (nights already booked keep their price),
 * moving the guest to another villa of the same type if needed, or decline
 * with a reason. Only confirmed bookings that have not started; one open
 * request at a time; a waiting request can be withdrawn.
 */

export type DateChangeError =
  | StayChangeError
  | "not_allowed"
  | "already_requested"
  | "not_pending"
  | "reason_required";

/** What the guest sees for new dates: the new total if their villa is free, or that another villa would be needed. */
export async function previewGuestDateChange(db: AnyDb, input: { reservationId: string; checkIn: string; checkOut: string; now?: Date }) {
  const [r] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, input.reservationId));
  if (!r) return { ok: false as const, error: "not_found" as DateChangeError };
  if (r.status !== "confirmed") return { ok: false as const, error: "not_allowed" as DateChangeError };
  const result = await previewStayChange(db, { reservationId: r.id, checkIn: input.checkIn, checkOut: input.checkOut, unitId: r.unitId, now: input.now });
  if (result.ok) return { ok: true as const, sameVilla: true, total: result.plan.total, difference: result.plan.difference, previousTotal: r.totalAmount };
  // Taken on this villa but another of the same type is free: staff can move the guest.
  if ((result.error === "dates_unavailable" || result.error === "unit_blocked" || result.error === "channel_booked") && result.alternatives?.length) {
    return { ok: true as const, sameVilla: false, total: null, difference: null, previousTotal: r.totalAmount };
  }
  return { ok: false as const, error: result.error as DateChangeError, minNights: result.minNights, maxNights: result.maxNights };
}

/** The guest asks for new dates. */
export async function requestDateChangeAsGuest(db: AnyDb, input: { reservationId: string; checkIn: string; checkOut: string; note?: string | null; now?: Date }) {
  const now = input.now ?? new Date();
  const preview = await previewGuestDateChange(db, input);
  if (!preview.ok) return preview;
  const [open] = await db.select({ id: schema.dateChangeRequests.id }).from(schema.dateChangeRequests).where(and(eq(schema.dateChangeRequests.reservationId, input.reservationId), eq(schema.dateChangeRequests.status, "requested")));
  if (open) return { ok: false as const, error: "already_requested" as DateChangeError };
  const [r] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, input.reservationId));
  const inserted = await db
    .insert(schema.dateChangeRequests)
    .values({ reservationId: r.id, checkIn: input.checkIn, checkOut: input.checkOut, quotedTotal: preview.total, previousTotal: r.totalAmount, note: input.note?.trim().slice(0, 500) || null, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning({ id: schema.dateChangeRequests.id });
  if (!inserted.length) return { ok: false as const, error: "already_requested" as DateChangeError };
  await db.insert(schema.auditEvents).values({ actorType: "guest", propertyId: r.propertyId, entityType: "reservation", entityId: r.id, action: "date_change.requested", after: { checkIn: input.checkIn, checkOut: input.checkOut, quotedTotal: preview.total }, occurredAt: now });
  return { ok: true as const };
}

/** The guest withdraws a request that staff have not decided yet. */
export async function cancelDateChangeAsGuest(db: AnyDb, input: { reservationId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const updated = await db
    .update(schema.dateChangeRequests)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(schema.dateChangeRequests.reservationId, input.reservationId), eq(schema.dateChangeRequests.status, "requested")))
    .returning({ id: schema.dateChangeRequests.id });
  if (!updated.length) return { ok: false as const, error: "not_pending" as DateChangeError };
  const [r] = await db.select({ propertyId: schema.reservations.propertyId }).from(schema.reservations).where(eq(schema.reservations.id, input.reservationId));
  await db.insert(schema.auditEvents).values({ actorType: "guest", propertyId: r?.propertyId ?? null, entityType: "reservation", entityId: input.reservationId, action: "date_change.withdrawn", after: {}, occurredAt: now });
  return { ok: true as const };
}

/** The latest request of a booking (the open one first). */
export async function latestDateChange(db: AnyDb, reservationId: string) {
  const [row] = await db.select().from(schema.dateChangeRequests).where(eq(schema.dateChangeRequests.reservationId, reservationId)).orderBy(desc(schema.dateChangeRequests.createdAt)).limit(1);
  return row ?? null;
}

/**
 * Approves the open request: the change is applied (to `unitId`, the guest's
 * villa unless staff move them) at the price previewed now. The guest gets
 * the usual "booking changed" message.
 */
export async function approveDateChange(db: AnyDb, input: { reservationId: string; unitId: string; actor: Actor; now?: Date }) {
  const now = input.now ?? new Date();
  const req = await latestDateChange(db, input.reservationId);
  if (!req || req.status !== "requested") return { ok: false as const, error: "not_pending" as DateChangeError };
  const preview = await previewStayChange(db, { reservationId: input.reservationId, checkIn: req.checkIn, checkOut: req.checkOut, unitId: input.unitId, now });
  if (!preview.ok) return { ok: false as const, error: preview.error as DateChangeError, codes: preview.codes };
  const applied = await applyStayChange(db, { reservationId: input.reservationId, checkIn: req.checkIn, checkOut: req.checkOut, unitId: input.unitId, expectedTotal: preview.plan.total, actor: input.actor, now });
  if (!applied.ok) return { ok: false as const, error: applied.error as DateChangeError, codes: applied.codes };
  await db.update(schema.dateChangeRequests).set({ status: "approved", decidedBy: input.actor.id, decidedAt: now, updatedAt: now }).where(eq(schema.dateChangeRequests.id, req.id));
  return { ok: true as const };
}

/** Declines the open request with a reason the guest is told. */
export async function declineDateChange(db: AnyDb, input: { reservationId: string; reason: string; actor: Actor; now?: Date }) {
  const now = input.now ?? new Date();
  const reason = input.reason.trim().slice(0, 300);
  if (!reason) return { ok: false as const, error: "reason_required" as DateChangeError };
  const req = await latestDateChange(db, input.reservationId);
  if (!req || req.status !== "requested") return { ok: false as const, error: "not_pending" as DateChangeError };
  await db.transaction(async (tx) => {
    await tx.update(schema.dateChangeRequests).set({ status: "declined", declineReason: reason, decidedBy: input.actor.id, decidedAt: now, updatedAt: now }).where(eq(schema.dateChangeRequests.id, req.id));
    const [r] = await tx.select({ propertyId: schema.reservations.propertyId }).from(schema.reservations).where(eq(schema.reservations.id, input.reservationId));
    await tx.insert(schema.auditEvents).values({ actorType: "staff", actorId: input.actor.id, propertyId: r?.propertyId ?? null, entityType: "reservation", entityId: input.reservationId, action: "date_change.declined", after: { checkIn: req.checkIn, checkOut: req.checkOut, reason }, occurredAt: now });
    await queueGuestMessage(tx, { reservationId: input.reservationId, kind: "date_change_declined", payload: { checkIn: req.checkIn, checkOut: req.checkOut, reason }, dedupe: `date-change:${req.id}`, now });
  });
  return { ok: true as const };
}
