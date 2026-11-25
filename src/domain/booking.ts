import { randomInt } from "node:crypto";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { brand } from "@/config/brand";
import * as schema from "@/db/schema";
import type { Locale } from "@/i18n/config";
import { todayIn } from "./dates";
import { cancellationOutcome, quoteStay, type PricingRules, type Quote, type QuoteError } from "./pricing";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Tx = Parameters<Parameters<AnyDb["transaction"]>[0]>[0];
type Executor = AnyDb | Tx;

const EXCLUSION_VIOLATION = "23P01";

function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  while (current && typeof current === "object") {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

/** Unambiguous characters only (no 0/O, 1/I/L) so codes survive being read aloud. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function newBookingCode(): string {
  let body = "";
  for (let i = 0; i < 8; i += 1) body += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${brand.bookingPrefix}-${body}`;
}

/**
 * SQL condition: this unit has no reservation that occupies any night of
 * [checkIn, checkOut). Holds count only until they expire.
 */
function unitIsFree(checkIn: string, checkOut: string, now: Date) {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${schema.reservations} r
    WHERE r.unit_id = ${schema.units.id}
      AND daterange(r.check_in, r.check_out, '[)') && daterange(${checkIn}::date, ${checkOut}::date, '[)')
      AND (
        r.status IN ('confirmed', 'in_house', 'checked_out')
        OR (r.status = 'hold' AND r.hold_expires_at > ${now.toISOString()}::timestamptz)
      )
  ) AND NOT EXISTS (
    SELECT 1 FROM ${schema.unitBlocks} b
    WHERE b.unit_id = ${schema.units.id}
      AND b.status = 'open'
      AND daterange(b.start_date, b.end_date, '[)') && daterange(${checkIn}::date, ${checkOut}::date, '[)')
  )`;
}

type UnitTypeWithPolicy = {
  type: typeof schema.unitTypes.$inferSelect;
  property: typeof schema.properties.$inferSelect;
  rules: PricingRules;
};

async function loadUnitTypes(db: Executor, unitTypeIds: string[]): Promise<Map<string, UnitTypeWithPolicy>> {
  if (unitTypeIds.length === 0) return new Map();
  const rows = await db
    .select({ type: schema.unitTypes, property: schema.properties })
    .from(schema.unitTypes)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.unitTypes.propertyId))
    .where(inArray(schema.unitTypes.id, unitTypeIds));
  const seasons = await db
    .select()
    .from(schema.rateSeasons)
    .where(inArray(schema.rateSeasons.unitTypeId, unitTypeIds))
    .orderBy(asc(schema.rateSeasons.startDate));

  return new Map(
    rows.map(({ type, property }) => [
      type.id,
      {
        type,
        property,
        rules: {
          baseRate: type.baseRate,
          minStayNights: type.minStayNights,
          maxStayNights: type.maxStayNights,
          seasons: seasons
            .filter((s) => s.unitTypeId === type.id)
            .map((s) => ({
              name: s.name,
              startDate: s.startDate,
              endDate: s.endDate,
              nightlyRate: s.nightlyRate,
              minStayNights: s.minStayNights,
            })),
          taxRateBp: property.taxRateBp,
          serviceRateBp: property.serviceRateBp,
          depositRateBp: property.depositRateBp,
          balanceDueDays: property.balanceDueDays,
        },
      },
    ]),
  );
}

export type SearchInput = {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  propertySlug?: string;
  now?: Date;
};

export type SearchResult = {
  unitType: typeof schema.unitTypes.$inferSelect;
  property: typeof schema.properties.$inferSelect;
  totalUnits: number;
  freeUnits: number;
  fitsGuests: boolean;
  quote: { ok: true; quote: Quote } | { ok: false; error: QuoteError };
};

/** Every published villa type (optionally of one property) with availability and price for the dates. */
export async function searchAvailability(db: AnyDb, input: SearchInput): Promise<SearchResult[]> {
  const now = input.now ?? new Date();
  const typeRows = await db
    .select({ id: schema.unitTypes.id })
    .from(schema.unitTypes)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.unitTypes.propertyId))
    .where(
      and(
        eq(schema.unitTypes.isPublished, true),
        eq(schema.properties.isActive, true),
        input.propertySlug ? eq(schema.properties.slug, input.propertySlug) : undefined,
      ),
    );
  const types = await loadUnitTypes(
    db,
    typeRows.map((t) => t.id),
  );
  if (types.size === 0) return [];

  const counts = await db
    .select({
      unitTypeId: schema.units.unitTypeId,
      total: sql<number>`count(*)::int`,
      free: sql<number>`count(*) FILTER (WHERE ${unitIsFree(input.checkIn, input.checkOut, now)})::int`,
    })
    .from(schema.units)
    .where(and(eq(schema.units.isActive, true), inArray(schema.units.unitTypeId, [...types.keys()])))
    .groupBy(schema.units.unitTypeId);

  return [...types.values()]
    .map(({ type, property, rules }) => {
      const count = counts.find((c) => c.unitTypeId === type.id);
      return {
        unitType: type,
        property,
        totalUnits: count?.total ?? 0,
        freeUnits: count?.free ?? 0,
        fitsGuests: input.adults + input.children <= type.maxGuests,
        quote: quoteStay(rules, {
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          today: todayIn(property.timezone, now),
        }),
      };
    })
    .sort((a, b) => a.property.name.localeCompare(b.property.name) || a.unitType.sortOrder - b.unitType.sortOrder);
}

export type HoldInput = {
  unitTypeId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  guest: { fullName: string; email: string; phone?: string | null; countryCode?: string | null };
  specialRequests?: string | null;
  estimatedArrival?: string | null;
  locale: Locale;
  source: (typeof schema.bookingSource.enumValues)[number];
  now?: Date;
  /** Tests only: try these units first, in this order. */
  candidateUnitIds?: string[];
};

export type HoldError =
  | { kind: "unknown_unit_type" }
  | { kind: "too_many_guests"; maxGuests: number }
  | { kind: "invalid_guest" }
  | { kind: "sold_out" }
  | ({ kind: "quote" } & { error: QuoteError });

export type HoldResult =
  | { ok: true; reservation: typeof schema.reservations.$inferSelect; quote: Quote }
  | { ok: false; error: HoldError };

/**
 * Holds one free unit of a villa type while the guest pays. Expired holds of
 * that type are released first. If another booking takes the chosen unit
 * between the availability check and the insert, the database's overlap
 * guard rejects ours and the next free unit is tried.
 */
export async function createHold(db: AnyDb, input: HoldInput): Promise<HoldResult> {
  const now = input.now ?? new Date();
  const email = input.guest.email.trim().toLowerCase();
  const fullName = input.guest.fullName.trim();
  if (!fullName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: { kind: "invalid_guest" } };
  if (!Number.isInteger(input.adults) || input.adults < 1 || !Number.isInteger(input.children) || input.children < 0) {
    return { ok: false, error: { kind: "invalid_guest" } };
  }

  return db.transaction(async (tx) => {
    const loaded = (await loadUnitTypes(tx, [input.unitTypeId])).get(input.unitTypeId);
    if (!loaded || !loaded.type.isPublished || !loaded.property.isActive) {
      return { ok: false, error: { kind: "unknown_unit_type" } } as const;
    }
    const { type, property, rules } = loaded;
    if (input.adults + input.children > type.maxGuests) {
      return { ok: false, error: { kind: "too_many_guests", maxGuests: type.maxGuests } } as const;
    }
    const priced = quoteStay(rules, {
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      today: todayIn(property.timezone, now),
    });
    if (!priced.ok) return { ok: false, error: { kind: "quote", error: priced.error } } as const;
    const quote = priced.quote;

    await tx
      .update(schema.reservations)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(schema.reservations.unitTypeId, type.id),
          eq(schema.reservations.status, "hold"),
          lte(schema.reservations.holdExpiresAt, now),
        ),
      );

    const free = await tx
      .select({ id: schema.units.id })
      .from(schema.units)
      .where(
        and(
          eq(schema.units.unitTypeId, type.id),
          eq(schema.units.isActive, true),
          unitIsFree(input.checkIn, input.checkOut, now),
        ),
      )
      .orderBy(asc(schema.units.code));
    const order = input.candidateUnitIds ?? free.map((u) => u.id);
    if (order.length === 0) return { ok: false, error: { kind: "sold_out" } } as const;

    const [guest] = await tx
      .insert(schema.guests)
      .values({
        fullName,
        email,
        phone: input.guest.phone?.trim() || null,
        countryCode: input.guest.countryCode?.trim().toUpperCase() || null,
      })
      .returning();

    const holdExpiresAt = new Date(now.getTime() + property.holdMinutes * 60_000);
    for (const unitId of order) {
      try {
        const reservation = await tx.transaction(async (sp) => {
          await sp.execute(sql`SELECT 1 FROM ${schema.units} WHERE id = ${unitId} FOR UPDATE`);
          const blocked = await sp.execute(sql`
            SELECT 1 FROM ${schema.unitBlocks} b
            WHERE b.unit_id = ${unitId} AND b.status = 'open'
              AND daterange(b.start_date, b.end_date, '[)') && daterange(${input.checkIn}::date, ${input.checkOut}::date, '[)')
            LIMIT 1`);
          const blockedRows = Array.isArray(blocked) ? blocked : (blocked as unknown as { rows: unknown[] }).rows;
          if (blockedRows.length > 0) throw new UnitBlockedError();
          const [row] = await sp
            .insert(schema.reservations)
            .values({
              code: newBookingCode(),
              propertyId: property.id,
              unitTypeId: type.id,
              unitId,
              guestId: guest.id,
              status: "hold",
              source: input.source,
              checkIn: input.checkIn,
              checkOut: input.checkOut,
              adults: input.adults,
              children: input.children,
              totalAmount: quote.total,
              subtotalAmount: quote.subtotal,
              serviceAmount: quote.service,
              taxAmount: quote.tax,
              depositAmount: quote.dueNow,
              balanceDueDate: quote.balanceDueDate,
              currency: property.currency,
              holdExpiresAt,
              estimatedArrival: input.estimatedArrival || null,
              specialRequests: input.specialRequests?.trim() || null,
              locale: input.locale,
              priceSnapshot: {
                nights: quote.nights,
                subtotal: quote.subtotal,
                service: quote.service,
                tax: quote.tax,
                total: quote.total,
                serviceRateBp: quote.serviceRateBp,
                taxRateBp: quote.taxRateBp,
              },
              policySnapshot: {
                cancellationTiers: property.cancellationTiers,
                depositRateBp: property.depositRateBp,
                balanceDueDays: property.balanceDueDays,
              },
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          return row;
        });
        await tx.insert(schema.auditEvents).values({
          actorType: input.source === "website" ? "guest" : "staff",
          propertyId: property.id,
          entityType: "reservation",
          entityId: reservation.id,
          action: "reservation.held",
          after: { code: reservation.code, unitId, checkIn: input.checkIn, checkOut: input.checkOut },
          occurredAt: now,
        });
        return { ok: true, reservation, quote } as const;
      } catch (error) {
        if (sqlState(error) === EXCLUSION_VIOLATION || error instanceof UnitBlockedError) continue; // taken or blocked a moment ago; try the next unit
        throw error;
      }
    }
    // Every candidate was taken concurrently. Throwing rolls back the guest row too.
    throw new SoldOutError();
  }).catch((error: unknown) => {
    if (error instanceof SoldOutError) return { ok: false, error: { kind: "sold_out" } } as const;
    throw error;
  });
}

class SoldOutError extends Error {}
class UnitBlockedError extends Error {}

/** Records a payment that is waiting for the guest at the provider. */
export async function createPendingPayment(
  db: Executor,
  input: {
    reservationId: string;
    provider: (typeof schema.paymentProvider.enumValues)[number];
    providerRef: string;
    purpose: (typeof schema.paymentPurpose.enumValues)[number];
    amount: number;
    checkoutUrl: string | null;
    expiresAt: Date | null;
  },
) {
  const [payment] = await db.insert(schema.payments).values({ ...input, status: "pending" }).returning();
  return payment;
}

export type PaymentOutcome =
  | { kind: "confirmed"; reservationId: string }
  | { kind: "recorded"; reservationId: string }
  | { kind: "already_processed"; reservationId: string }
  | { kind: "needs_refund"; reservationId: string; reason: "unit_taken_after_expiry" | "reservation_cancelled" }
  | { kind: "unknown_payment" }
  | { kind: "amount_mismatch"; reservationId: string; expected: number; received: number };

/**
 * Applies a successful payment from the provider. Safe to call more than once
 * for the same (provider, providerRef): only the first call changes anything.
 */
export async function recordPaymentPaid(
  db: AnyDb,
  input: {
    provider: (typeof schema.paymentProvider.enumValues)[number];
    providerRef: string;
    amount: number;
    paidAt: Date;
    raw?: unknown;
  },
): Promise<PaymentOutcome> {
  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.provider, input.provider), eq(schema.payments.providerRef, input.providerRef)))
      .for("update");
    if (!payment) return { kind: "unknown_payment" } as const;
    if (payment.status === "paid") return { kind: "already_processed", reservationId: payment.reservationId } as const;
    if (input.amount !== payment.amount) {
      await tx
        .update(schema.payments)
        .set({ status: "failed", raw: input.raw ?? null, updatedAt: input.paidAt })
        .where(eq(schema.payments.id, payment.id));
      return {
        kind: "amount_mismatch",
        reservationId: payment.reservationId,
        expected: payment.amount,
        received: input.amount,
      } as const;
    }

    await tx
      .update(schema.payments)
      .set({ status: "paid", paidAt: input.paidAt, raw: input.raw ?? null, updatedAt: input.paidAt })
      .where(eq(schema.payments.id, payment.id));

    const [reservation] = await tx
      .update(schema.reservations)
      .set({ amountPaid: sql`${schema.reservations.amountPaid} + ${payment.amount}`, updatedAt: input.paidAt })
      .where(eq(schema.reservations.id, payment.reservationId))
      .returning();

    const audit = (action: string, after: Record<string, unknown>) =>
      tx.insert(schema.auditEvents).values({
        actorType: "system",
        propertyId: reservation.propertyId,
        entityType: "reservation",
        entityId: reservation.id,
        action,
        after,
        occurredAt: input.paidAt,
      });

    if (reservation.status === "cancelled" || reservation.status === "no_show") {
      await tx
        .update(schema.reservations)
        .set({ refundAmount: sql`coalesce(${schema.reservations.refundAmount}, 0) + ${payment.amount}` })
        .where(eq(schema.reservations.id, reservation.id));
      await audit("payment.received_after_cancellation", { paymentId: payment.id, amount: payment.amount });
      return { kind: "needs_refund", reservationId: reservation.id, reason: "reservation_cancelled" } as const;
    }

    if (reservation.status === "hold" || reservation.status === "expired") {
      try {
        await tx.transaction(async (sp) => {
          await sp
            .update(schema.reservations)
            .set({ status: "confirmed", holdExpiresAt: null, updatedAt: input.paidAt })
            .where(eq(schema.reservations.id, reservation.id));
        });
      } catch (error) {
        if (sqlState(error) !== EXCLUSION_VIOLATION) throw error;
        // The hold lapsed and someone else booked the unit before this payment arrived.
        await tx
          .update(schema.reservations)
          .set({ refundAmount: sql`coalesce(${schema.reservations.refundAmount}, 0) + ${payment.amount}` })
          .where(eq(schema.reservations.id, reservation.id));
        await audit("payment.received_after_expiry", { paymentId: payment.id, amount: payment.amount });
        return { kind: "needs_refund", reservationId: reservation.id, reason: "unit_taken_after_expiry" } as const;
      }
      await audit("reservation.confirmed", { paymentId: payment.id, amount: payment.amount });
      const [guest] = await tx.select().from(schema.guests).where(eq(schema.guests.id, reservation.guestId));
      if (guest?.email) {
        await tx.insert(schema.notificationOutbox).values({
          kind: "booking_confirmed",
          channel: "email",
          recipient: guest.email,
          reservationId: reservation.id,
          payload: { code: reservation.code, locale: reservation.locale },
        });
      }
      return { kind: "confirmed", reservationId: reservation.id } as const;
    }

    await audit("payment.recorded", { paymentId: payment.id, amount: payment.amount });
    return { kind: "recorded", reservationId: reservation.id } as const;
  });
}

export type CancelResult =
  | { ok: true; refund: number; fee: number }
  | { ok: false; error: "not_found" | "not_cancellable" };

/** Cancels a hold or confirmed booking and records the refund owed under the policy saved with it. */
export async function cancelReservation(
  db: AnyDb,
  input: {
    reservationId: string;
    actor: { type: "staff" | "guest" | "system"; id?: string };
    reason?: string | null;
    now?: Date;
  },
): Promise<CancelResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ reservation: schema.reservations, timezone: schema.properties.timezone })
      .from(schema.reservations)
      .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
      .where(eq(schema.reservations.id, input.reservationId))
      .for("update", { of: schema.reservations });
    if (!row) return { ok: false, error: "not_found" } as const;
    const r = row.reservation;
    if (r.status !== "hold" && r.status !== "confirmed") return { ok: false, error: "not_cancellable" } as const;

    const outcome = cancellationOutcome({
      tiers: r.policySnapshot?.cancellationTiers ?? [],
      total: r.totalAmount,
      amountPaid: r.amountPaid,
      checkIn: r.checkIn,
      today: todayIn(row.timezone, now),
    });

    await tx
      .update(schema.reservations)
      .set({
        status: "cancelled",
        cancelledAt: now,
        cancellationReason: input.reason?.trim() || null,
        refundAmount: outcome.refund,
        holdExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(schema.reservations.id, r.id));
    await tx.insert(schema.auditEvents).values({
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      propertyId: r.propertyId,
      entityType: "reservation",
      entityId: r.id,
      action: "reservation.cancelled",
      before: { status: r.status },
      after: { status: "cancelled", refund: outcome.refund, fee: outcome.fee, reason: input.reason ?? null },
      occurredAt: now,
    });
    return { ok: true, refund: outcome.refund, fee: outcome.fee } as const;
  });
}

/** Releases holds whose time ran out. Run every minute or so. */
export async function expireHolds(db: AnyDb, now: Date = new Date()): Promise<number> {
  const expired = await db
    .update(schema.reservations)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(schema.reservations.status, "hold"), lte(schema.reservations.holdExpiresAt, now)))
    .returning({ id: schema.reservations.id });
  return expired.length;
}

/** Finds a booking for the guest portal. Both code and email must match. */
export async function findGuestReservation(db: AnyDb, code: string, email: string) {
  const [row] = await db
    .select({ reservation: schema.reservations, guest: schema.guests })
    .from(schema.reservations)
    .innerJoin(schema.guests, eq(schema.guests.id, schema.reservations.guestId))
    .where(
      and(
        eq(schema.reservations.code, code.trim().toUpperCase()),
        sql`lower(${schema.guests.email}) = ${email.trim().toLowerCase()}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Free units of a villa type for each night in [from, from + days). */
export async function availabilityCalendar(
  db: AnyDb,
  input: { unitTypeId: string; from: string; days: number; now?: Date },
): Promise<Array<{ date: string; free: number }>> {
  const now = input.now ?? new Date();
  const result = await db.execute<{ date: string; free: number }>(sql`
    SELECT to_char(d, 'YYYY-MM-DD') AS date,
      count(u.id) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM ${schema.reservations} r
        WHERE r.unit_id = u.id
          AND daterange(r.check_in, r.check_out, '[)') @> d::date
          AND (
            r.status IN ('confirmed', 'in_house', 'checked_out')
            OR (r.status = 'hold' AND r.hold_expires_at > ${now.toISOString()}::timestamptz)
          )
      ) AND NOT EXISTS (
        SELECT 1 FROM ${schema.unitBlocks} b
        WHERE b.unit_id = u.id AND b.status = 'open' AND daterange(b.start_date, b.end_date, '[)') @> d::date
      ))::int AS free
    FROM generate_series(${input.from}::date, ${input.from}::date + (${input.days}::int - 1), interval '1 day') AS d
    LEFT JOIN ${schema.units} u ON u.unit_type_id = ${input.unitTypeId} AND u.is_active
    GROUP BY d
    ORDER BY d
  `);
  // postgres-js returns the rows as an array; PGlite wraps them in { rows }.
  type Row = { date: string; free: number | string };
  const raw = result as unknown;
  const rows = (Array.isArray(raw) ? raw : (raw as { rows: Row[] }).rows) as Row[];
  return rows.map((r) => ({ date: r.date, free: Number(r.free) }));
}
