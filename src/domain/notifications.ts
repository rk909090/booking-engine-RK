import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { addDays, diffDays, todayIn } from "./dates";
import { guaranteeDue } from "./guarantee";
import { balanceDue } from "./pricing";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Tx = Parameters<Parameters<AnyDb["transaction"]>[0]>[0];
type Executor = AnyDb | Tx;

/*
 * Messages to guests (decided with the owner, 26 Nov 2026): sent by email
 * and by WhatsApp, to whichever contact the guest gave (both when there are
 * both). Email carries the full details; WhatsApp a short approved template
 * with a link to the booking page.
 *
 * Messages are queued in notification_outbox in the same transaction as the
 * change that causes them, and delivered afterwards (lib/notifications). A
 * channel without its keys keeps its messages waiting; messages not sent
 * within MAX_AGE_HOURS are skipped, so nobody gets a stale confirmation days
 * later once keys are added.
 */

export const MESSAGE_KINDS = [
  "booking_confirmed",
  "booking_modified",
  "booking_cancelled",
  "late_checkout_decided",
  "early_checkin_decided",
  "precheckin_reminder",
  "payment_reminder",
  "addon_decided",
  "date_change_declined",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type Channel = "email" | "whatsapp";

export const MAX_ATTEMPTS = 5;
export const MAX_AGE_HOURS = 48;
/** A claim older than this is taken to be a crashed worker and retried. */
export const STALE_CLAIM_MINUTES = 10;
/** Minutes to wait before attempt 2, 3, 4, 5. */
export const RETRY_MINUTES = [1, 5, 15, 60];
/** Pre-check-in reminder: this many days before arrival (or fewer, if booked later). */
export const PRECHECKIN_REMINDER_DAYS = 3;

/**
 * A WhatsApp number in international form without "+" (e.g. 628111234567),
 * or null. Numbers starting with 0 are taken as Indonesian.
 */
export function whatsappNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("00")) digits = digits.slice(2);
  else if (!trimmed.startsWith("+") && digits.startsWith("0")) digits = `62${digits.slice(1)}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

/**
 * Queues a message for the guest of a booking on every channel they can be
 * reached on. With `dedupe`, a message that was already queued is not queued
 * again (reminders).
 */
export async function queueGuestMessage(
  db: Executor,
  input: { reservationId: string; kind: MessageKind; payload?: Record<string, unknown>; dedupe?: string; now?: Date },
): Promise<number> {
  const [row] = await db
    .select({ code: schema.reservations.code, locale: schema.reservations.locale, email: schema.guests.email, phone: schema.guests.phone })
    .from(schema.reservations)
    .innerJoin(schema.guests, eq(schema.guests.id, schema.reservations.guestId))
    .where(eq(schema.reservations.id, input.reservationId));
  if (!row) return 0;
  const recipients: Array<[Channel, string]> = [];
  if (row.email) recipients.push(["email", row.email]);
  const wa = whatsappNumber(row.phone);
  if (wa) recipients.push(["whatsapp", wa]);
  if (recipients.length === 0) return 0;
  const now = input.now ?? new Date();
  const inserted = await db
    .insert(schema.notificationOutbox)
    .values(
      recipients.map(([channel, recipient]) => ({
        kind: input.kind,
        channel,
        recipient,
        reservationId: input.reservationId,
        payload: { code: row.code, locale: row.locale, ...(input.payload ?? {}) },
        dedupeKey: input.dedupe ? `${input.dedupe}:${channel}` : null,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing({ target: schema.notificationOutbox.dedupeKey })
    .returning({ id: schema.notificationOutbox.id });
  return inserted.length;
}

/**
 * Queues the day's reminders (run by the scheduled job; safe to run often):
 * - pre-check-in, PRECHECKIN_REMINDER_DAYS days before arrival or fewer, when not done yet;
 * - payment, the day before (or on) the due date of a balance or of a deposit
 *   promised under a guarantee, when still unpaid.
 */
export async function queueReminders(db: AnyDb, now: Date = new Date()): Promise<{ precheckin: number; payment: number }> {
  const rows = await db
    .select({ r: schema.reservations, timezone: schema.properties.timezone, preCheckin: schema.preCheckins.id })
    .from(schema.reservations)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .leftJoin(schema.preCheckins, eq(schema.preCheckins.reservationId, schema.reservations.id))
    .where(and(eq(schema.reservations.status, "confirmed"), gte(schema.reservations.checkIn, sql`current_date - 1`)));
  let precheckin = 0;
  let payment = 0;
  for (const { r, timezone, preCheckin } of rows) {
    const today = todayIn(timezone, now);
    const daysToArrival = diffDays(today, r.checkIn);
    if (!preCheckin && daysToArrival >= 1 && daysToArrival <= PRECHECKIN_REMINDER_DAYS) {
      precheckin += await queueGuestMessage(db, { reservationId: r.id, kind: "precheckin_reminder", dedupe: `precheckin_reminder:${r.id}:${r.checkIn}`, now });
    }
    const deposit = guaranteeDue(r, today);
    const due = deposit ? { amount: deposit.amount, date: deposit.payBy } : balanceDue(r) > 0 && r.balanceDueDate ? { amount: balanceDue(r), date: r.balanceDueDate } : null;
    if (due && (due.date === addDays(today, 1) || due.date === today)) {
      payment += await queueGuestMessage(db, {
        reservationId: r.id,
        kind: "payment_reminder",
        payload: { amount: due.amount, dueDate: due.date },
        dedupe: `payment_reminder:${r.id}:${due.date}`,
        now,
      });
    }
  }
  return { precheckin, payment };
}

export type OutboxMessage = typeof schema.notificationOutbox.$inferSelect;

/**
 * Takes up to `limit` messages ready to send on the given channels and marks
 * them as being sent, so two workers never send the same message. Also
 * skips messages too old to be useful and frees stale claims.
 */
export async function claimMessages(db: AnyDb, input: { channels: Channel[]; now?: Date; limit?: number }): Promise<OutboxMessage[]> {
  const now = input.now ?? new Date();
  const oldest = new Date(now.getTime() - MAX_AGE_HOURS * 3_600_000);
  const staleClaim = new Date(now.getTime() - STALE_CLAIM_MINUTES * 60_000);
  await db
    .update(schema.notificationOutbox)
    .set({ status: "pending", claimedAt: null, updatedAt: now })
    .where(and(eq(schema.notificationOutbox.status, "sending"), lt(schema.notificationOutbox.claimedAt, staleClaim)));
  await db
    .update(schema.notificationOutbox)
    .set({ status: "skipped", lastError: `not sent within ${MAX_AGE_HOURS} hours`, updatedAt: now })
    .where(and(eq(schema.notificationOutbox.status, "pending"), lt(schema.notificationOutbox.createdAt, oldest)));
  if (input.channels.length === 0) return [];

  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: schema.notificationOutbox.id })
      .from(schema.notificationOutbox)
      .where(
        and(
          eq(schema.notificationOutbox.status, "pending"),
          inArray(schema.notificationOutbox.channel, input.channels),
          or(isNull(schema.notificationOutbox.nextAttemptAt), lte(schema.notificationOutbox.nextAttemptAt, now)),
        ),
      )
      .orderBy(asc(schema.notificationOutbox.createdAt))
      .limit(input.limit ?? 20)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(schema.notificationOutbox)
      .set({ status: "sending", claimedAt: now, attempts: sql`${schema.notificationOutbox.attempts} + 1`, updatedAt: now })
      .where(inArray(schema.notificationOutbox.id, due.map((d) => d.id)))
      .returning();
  });
}

/** Records the outcome of one send. A failure is retried with backoff until MAX_ATTEMPTS, unless it cannot succeed. */
export async function finishMessage(
  db: AnyDb,
  message: OutboxMessage,
  outcome: { ok: true; providerRef?: string | null } | { ok: false; error: string; permanent?: boolean },
  now: Date = new Date(),
) {
  if (outcome.ok) {
    await db
      .update(schema.notificationOutbox)
      .set({ status: "sent", sentAt: now, providerRef: outcome.providerRef ?? null, lastError: null, claimedAt: null, updatedAt: now })
      .where(eq(schema.notificationOutbox.id, message.id));
    return;
  }
  const giveUp = outcome.permanent || message.attempts >= MAX_ATTEMPTS;
  const wait = RETRY_MINUTES[Math.min(message.attempts, RETRY_MINUTES.length) - 1] ?? 60;
  await db
    .update(schema.notificationOutbox)
    .set({
      status: giveUp ? "failed" : "pending",
      lastError: outcome.error.slice(0, 500),
      nextAttemptAt: giveUp ? null : new Date(now.getTime() + wait * 60_000),
      claimedAt: null,
      updatedAt: now,
    })
    .where(eq(schema.notificationOutbox.id, message.id));
}
