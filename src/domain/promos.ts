import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { diffDays } from "./dates";
import type { PromoOffer } from "./pricing";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Tx = Parameters<Parameters<AnyDb["transaction"]>[0]>[0];
type Executor = AnyDb | Tx;

/*
 * Promo codes (rules agreed with the owner, 26 Nov 2026). A code gives a
 * share or a rupiah amount off the nights' price and may be limited to
 * bookings made on certain dates, arrivals on certain dates, a minimum
 * number of nights, some villa types and a total number of bookings. Only
 * the largest discount applies (see domain/pricing.ts), so a valid code may
 * lose to an early-bird or long-stay discount; it then does not count as used.
 */

export type PromoError =
  | "promo_not_found"
  | "promo_not_started"
  | "promo_ended"
  | "promo_stay_dates"
  | "promo_min_nights"
  | "promo_villa"
  | "promo_used_up";

/** Codes are typed by guests: spaces dropped, upper case. */
export function cleanPromoCode(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export const PROMO_CODE = /^[A-Z0-9]{3,20}$/;

/** SQL: bookings that hold one use of a code (live holds and stays that went ahead). */
function usingCode(now: Date) {
  return sql`(${schema.reservations.status} IN ('confirmed', 'in_house', 'checked_out')
    OR (${schema.reservations.status} = 'hold' AND ${schema.reservations.holdExpiresAt} > ${now.toISOString()}::timestamptz))`;
}

/** Uses so far of each code. */
export async function promoUses(db: Executor, promoIds: string[], now: Date = new Date()): Promise<Map<string, number>> {
  if (promoIds.length === 0) return new Map();
  const rows = await db
    .select({ id: schema.reservations.promoCodeId, uses: sql<number>`count(*)::int` })
    .from(schema.reservations)
    .where(and(inArray(schema.reservations.promoCodeId, promoIds), usingCode(now)))
    .groupBy(schema.reservations.promoCodeId);
  return new Map(rows.map((r) => [r.id!, Number(r.uses)]));
}

/**
 * Checks a code against a stay. Inside a booking transaction pass `lock` so
 * two guests cannot both take the last use of a code.
 */
export async function checkPromo(
  db: Executor,
  input: { propertyId: string; unitTypeId: string; code: string; checkIn: string; checkOut: string; today: string; now: Date; lock?: boolean },
): Promise<{ ok: true; promo: PromoOffer } | { ok: false; error: PromoError }> {
  const code = cleanPromoCode(input.code);
  if (!PROMO_CODE.test(code)) return { ok: false, error: "promo_not_found" };
  const query = db
    .select()
    .from(schema.promoCodes)
    .where(and(eq(schema.promoCodes.propertyId, input.propertyId), eq(schema.promoCodes.code, code)));
  const [promo] = input.lock ? await query.for("update") : await query;
  if (!promo || !promo.isActive) return { ok: false, error: "promo_not_found" };
  if (promo.bookFrom && input.today < promo.bookFrom) return { ok: false, error: "promo_not_started" };
  if (promo.bookUntil && input.today > promo.bookUntil) return { ok: false, error: "promo_ended" };
  if ((promo.stayFrom && input.checkIn < promo.stayFrom) || (promo.stayUntil && input.checkIn > promo.stayUntil)) return { ok: false, error: "promo_stay_dates" };
  if (promo.minNights && diffDays(input.checkIn, input.checkOut) < promo.minNights) return { ok: false, error: "promo_min_nights" };
  if (promo.unitTypeIds.length > 0 && !promo.unitTypeIds.includes(input.unitTypeId)) return { ok: false, error: "promo_villa" };
  if (promo.maxUses !== null) {
    const uses = (await promoUses(db, [promo.id], input.now)).get(promo.id) ?? 0;
    if (uses >= promo.maxUses) return { ok: false, error: "promo_used_up" };
  }
  return {
    ok: true,
    promo: {
      code,
      promoCodeId: promo.id,
      discount: promo.kind === "percent" ? { kind: "percent", bp: promo.valueBp! } : { kind: "amount", amount: promo.amount! },
      minNights: promo.minNights,
    },
  };
}
