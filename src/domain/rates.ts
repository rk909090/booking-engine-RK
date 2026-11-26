import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { EXCLUSION_VIOLATION, sqlState } from "./booking";
import { isIsoDate } from "./dates";
import { cleanPromoCode, PROMO_CODE } from "./promos";
import type { LongStayTier } from "./types";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Actor = { type: "staff"; id: string };

/*
 * Rate settings, managed by branch managers (owner's decision, 26 Nov 2026):
 * base and weekend rates and stay limits per villa type, seasons, dates
 * closed to arrival, the rate plans and automatic discounts of a property,
 * and promo codes. Changes apply to new bookings only: existing bookings keep
 * the price saved with them. Every change is in the audit log.
 */

export type RatesResult = { ok: true; id?: string } | { ok: false; error: RatesError };
export type RatesError = "not_found" | "invalid" | "overlap" | "dates" | "code_taken" | "tiers" | "times";

const UNIQUE_VIOLATION = "23505";
const MAX_RATE = 1_000_000_000;
const validRate = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_RATE;
const validBp = (n: number) => Number.isInteger(n) && n >= 1 && n <= 9000;

async function audit(db: AnyDb, actor: Actor, propertyId: string, entityType: string, entityId: string, action: string, after: Record<string, unknown>, before: Record<string, unknown> | null = null) {
  await db.insert(schema.auditEvents).values({ actorType: actor.type, actorId: actor.id, propertyId, entityType, entityId, action, before, after, occurredAt: new Date() });
}

async function typeOf(db: AnyDb, unitTypeId: string) {
  const [type] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.id, unitTypeId));
  return type ?? null;
}

/** Base rate, weekend rate (Friday and Saturday nights; null = base rate) and stay limits of a villa type. */
export async function updateTypeRates(
  db: AnyDb,
  input: { unitTypeId: string; baseRate: number; weekendRate: number | null; minStayNights: number; maxStayNights: number; actor: Actor },
): Promise<RatesResult> {
  const type = await typeOf(db, input.unitTypeId);
  if (!type) return { ok: false, error: "not_found" };
  const { baseRate, weekendRate, minStayNights, maxStayNights } = input;
  if (!validRate(baseRate) || baseRate === 0 || (weekendRate !== null && (!validRate(weekendRate) || weekendRate === 0))) return { ok: false, error: "invalid" };
  if (!Number.isInteger(minStayNights) || !Number.isInteger(maxStayNights) || minStayNights < 1 || maxStayNights < minStayNights || maxStayNights > 365) return { ok: false, error: "invalid" };
  await db.update(schema.unitTypes).set({ baseRate, weekendRate, minStayNights, maxStayNights, updatedAt: new Date() }).where(eq(schema.unitTypes.id, type.id));
  await audit(db, input.actor, type.propertyId, "unit_type", type.id, "rates.type_updated", { baseRate, weekendRate, minStayNights, maxStayNights }, {
    baseRate: type.baseRate,
    weekendRate: type.weekendRate,
    minStayNights: type.minStayNights,
    maxStayNights: type.maxStayNights,
  });
  return { ok: true };
}

/** A season [startDate, endDate) with its own rate; seasons of a villa type may not overlap. */
export async function addSeason(
  db: AnyDb,
  input: { unitTypeId: string; name: string; startDate: string; endDate: string; nightlyRate: number; weekendRate: number | null; minStayNights: number | null; actor: Actor },
): Promise<RatesResult> {
  const type = await typeOf(db, input.unitTypeId);
  if (!type) return { ok: false, error: "not_found" };
  const name = input.name.trim().slice(0, 60);
  if (!name || !validRate(input.nightlyRate) || input.nightlyRate === 0 || (input.weekendRate !== null && (!validRate(input.weekendRate) || input.weekendRate === 0))) {
    return { ok: false, error: "invalid" };
  }
  if (input.minStayNights !== null && (!Number.isInteger(input.minStayNights) || input.minStayNights < 1 || input.minStayNights > 60)) return { ok: false, error: "invalid" };
  if (!isIsoDate(input.startDate) || !isIsoDate(input.endDate) || input.endDate <= input.startDate) return { ok: false, error: "dates" };
  try {
    const [season] = await db
      .insert(schema.rateSeasons)
      .values({ unitTypeId: type.id, name, startDate: input.startDate, endDate: input.endDate, nightlyRate: input.nightlyRate, weekendRate: input.weekendRate, minStayNights: input.minStayNights })
      .returning({ id: schema.rateSeasons.id });
    await audit(db, input.actor, type.propertyId, "unit_type", type.id, "rates.season_added", { seasonId: season.id, name, startDate: input.startDate, endDate: input.endDate, nightlyRate: input.nightlyRate, weekendRate: input.weekendRate, minStayNights: input.minStayNights });
    return { ok: true, id: season.id };
  } catch (error) {
    if (sqlState(error) === EXCLUSION_VIOLATION) return { ok: false, error: "overlap" };
    throw error;
  }
}

export async function removeSeason(db: AnyDb, input: { seasonId: string; actor: Actor }): Promise<RatesResult> {
  const [row] = await db
    .select({ season: schema.rateSeasons, propertyId: schema.unitTypes.propertyId })
    .from(schema.rateSeasons)
    .innerJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.rateSeasons.unitTypeId))
    .where(eq(schema.rateSeasons.id, input.seasonId));
  if (!row) return { ok: false, error: "not_found" };
  await db.delete(schema.rateSeasons).where(eq(schema.rateSeasons.id, row.season.id));
  const { name, startDate, endDate, nightlyRate, weekendRate } = row.season;
  await audit(db, input.actor, row.propertyId, "unit_type", row.season.unitTypeId, "rates.season_removed", { seasonId: row.season.id }, { name, startDate, endDate, nightlyRate, weekendRate });
  return { ok: true };
}

/** Closes arrivals on [startDate, endDate) for one villa type, or every type (unitTypeId null). */
export async function addArrivalClosure(
  db: AnyDb,
  input: { propertyId: string; unitTypeId: string | null; startDate: string; endDate: string; note: string | null; actor: Actor },
): Promise<RatesResult> {
  if (!isIsoDate(input.startDate) || !isIsoDate(input.endDate) || input.endDate <= input.startDate) return { ok: false, error: "dates" };
  if (input.unitTypeId) {
    const type = await typeOf(db, input.unitTypeId);
    if (!type || type.propertyId !== input.propertyId) return { ok: false, error: "not_found" };
  }
  const note = input.note?.trim().slice(0, 200) || null;
  const [row] = await db
    .insert(schema.arrivalClosures)
    .values({ propertyId: input.propertyId, unitTypeId: input.unitTypeId, startDate: input.startDate, endDate: input.endDate, note, createdBy: input.actor.id })
    .returning({ id: schema.arrivalClosures.id });
  await audit(db, input.actor, input.propertyId, "property", input.propertyId, "rates.arrival_closed", { closureId: row.id, unitTypeId: input.unitTypeId, startDate: input.startDate, endDate: input.endDate, note });
  return { ok: true, id: row.id };
}

export async function removeArrivalClosure(db: AnyDb, input: { closureId: string; actor: Actor }): Promise<RatesResult> {
  const [row] = await db.select().from(schema.arrivalClosures).where(eq(schema.arrivalClosures.id, input.closureId));
  if (!row) return { ok: false, error: "not_found" };
  await db.delete(schema.arrivalClosures).where(eq(schema.arrivalClosures.id, row.id));
  await audit(db, input.actor, row.propertyId, "property", row.propertyId, "rates.arrival_reopened", { closureId: row.id }, { unitTypeId: row.unitTypeId, startDate: row.startDate, endDate: row.endDate });
  return { ok: true };
}

export const MAX_LONG_STAY_TIERS = 3;

/** Long-stay tiers: at most three, at least 2 nights each, distinct, sorted by nights. */
export function normaliseTiers(tiers: LongStayTier[]): LongStayTier[] | null {
  if (tiers.length > MAX_LONG_STAY_TIERS) return null;
  const sorted = [...tiers].sort((a, b) => a.minNights - b.minNights);
  for (const [i, t] of sorted.entries()) {
    if (!Number.isInteger(t.minNights) || t.minNights < 2 || t.minNights > 365 || !validBp(t.bp)) return null;
    if (i > 0 && sorted[i - 1].minNights === t.minNights) return null;
  }
  return sorted;
}

/** Rate plans and automatic discounts of a property (null switches one off). */
export async function updateOffers(
  db: AnyDb,
  input: {
    propertyId: string;
    nonRefundableBp: number | null;
    breakfastPerGuest: number | null;
    earlyBirdDays: number | null;
    earlyBirdBp: number | null;
    longStayTiers: LongStayTier[];
    actor: Actor;
  },
): Promise<RatesResult> {
  const [property] = await db.select().from(schema.properties).where(eq(schema.properties.id, input.propertyId));
  if (!property) return { ok: false, error: "not_found" };
  if (input.nonRefundableBp !== null && !validBp(input.nonRefundableBp)) return { ok: false, error: "invalid" };
  if (input.breakfastPerGuest !== null && (!validRate(input.breakfastPerGuest) || input.breakfastPerGuest === 0)) return { ok: false, error: "invalid" };
  if ((input.earlyBirdDays === null) !== (input.earlyBirdBp === null)) return { ok: false, error: "invalid" };
  if (input.earlyBirdDays !== null && (!Number.isInteger(input.earlyBirdDays) || input.earlyBirdDays < 1 || input.earlyBirdDays > 365 || !validBp(input.earlyBirdBp!))) {
    return { ok: false, error: "invalid" };
  }
  const tiers = normaliseTiers(input.longStayTiers);
  if (!tiers) return { ok: false, error: "tiers" };
  const after = {
    nonRefundableBp: input.nonRefundableBp,
    breakfastPerGuest: input.breakfastPerGuest,
    earlyBirdDays: input.earlyBirdDays,
    earlyBirdBp: input.earlyBirdBp,
    longStayTiers: tiers,
  };
  await db.update(schema.properties).set({ ...after, updatedAt: new Date() }).where(eq(schema.properties.id, property.id));
  await audit(db, input.actor, property.id, "property", property.id, "rates.offers_updated", after, {
    nonRefundableBp: property.nonRefundableBp,
    breakfastPerGuest: property.breakfastPerGuest,
    earlyBirdDays: property.earlyBirdDays,
    earlyBirdBp: property.earlyBirdBp,
    longStayTiers: property.longStayTiers,
  });
  return { ok: true };
}

export type PromoInput = {
  propertyId: string;
  code: string;
  kind: "percent" | "amount";
  valueBp: number | null;
  amount: number | null;
  bookFrom: string | null;
  bookUntil: string | null;
  stayFrom: string | null;
  stayUntil: string | null;
  minNights: number | null;
  unitTypeIds: string[];
  maxUses: number | null;
  note: string | null;
  actor: Actor;
};

export async function createPromo(db: AnyDb, input: PromoInput): Promise<RatesResult> {
  const code = cleanPromoCode(input.code);
  if (!PROMO_CODE.test(code)) return { ok: false, error: "invalid" };
  if (input.kind === "percent" ? input.valueBp === null || !validBp(input.valueBp) : input.amount === null || !validRate(input.amount) || input.amount === 0) {
    return { ok: false, error: "invalid" };
  }
  const dates = [input.bookFrom, input.bookUntil, input.stayFrom, input.stayUntil];
  if (dates.some((d) => d !== null && !isIsoDate(d))) return { ok: false, error: "dates" };
  if ((input.bookFrom && input.bookUntil && input.bookUntil < input.bookFrom) || (input.stayFrom && input.stayUntil && input.stayUntil < input.stayFrom)) {
    return { ok: false, error: "dates" };
  }
  if (input.minNights !== null && (!Number.isInteger(input.minNights) || input.minNights < 1 || input.minNights > 365)) return { ok: false, error: "invalid" };
  if (input.maxUses !== null && (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > 100_000)) return { ok: false, error: "invalid" };
  if (input.unitTypeIds.length > 0) {
    const types = await db.select({ id: schema.unitTypes.id }).from(schema.unitTypes).where(eq(schema.unitTypes.propertyId, input.propertyId));
    if (input.unitTypeIds.some((id) => !types.some((t) => t.id === id))) return { ok: false, error: "not_found" };
  }
  const values = {
    propertyId: input.propertyId,
    code,
    kind: input.kind,
    valueBp: input.kind === "percent" ? input.valueBp : null,
    amount: input.kind === "amount" ? input.amount : null,
    bookFrom: input.bookFrom,
    bookUntil: input.bookUntil,
    stayFrom: input.stayFrom,
    stayUntil: input.stayUntil,
    minNights: input.minNights,
    unitTypeIds: [...new Set(input.unitTypeIds)],
    maxUses: input.maxUses,
    note: input.note?.trim().slice(0, 200) || null,
    createdBy: input.actor.id,
  };
  try {
    const [row] = await db.insert(schema.promoCodes).values(values).returning({ id: schema.promoCodes.id });
    const { createdBy, ...logged } = values;
    void createdBy;
    await audit(db, input.actor, input.propertyId, "promo_code", row.id, "promo.created", logged);
    return { ok: true, id: row.id };
  } catch (error) {
    if (sqlState(error) === UNIQUE_VIOLATION) return { ok: false, error: "code_taken" };
    throw error;
  }
}

/** Switches a code off (or back on). Codes are never deleted: bookings point to them. */
export async function setPromoActive(db: AnyDb, input: { promoId: string; active: boolean; actor: Actor }): Promise<RatesResult> {
  const [promo] = await db.select().from(schema.promoCodes).where(eq(schema.promoCodes.id, input.promoId));
  if (!promo) return { ok: false, error: "not_found" };
  await db
    .update(schema.promoCodes)
    .set({ isActive: input.active, updatedAt: new Date() })
    .where(eq(schema.promoCodes.id, promo.id));
  await audit(db, input.actor, promo.propertyId, "promo_code", promo.id, input.active ? "promo.activated" : "promo.deactivated", { code: promo.code });
  return { ok: true };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The latest late check-out and earliest early check-in a guest may ask for
 * from their booking page (staff can still arrange anything at the desk).
 */
export async function updateGuestTimes(db: AnyDb, input: { propertyId: string; lateLatest: string; earlyEarliest: string; actor: Actor }): Promise<RatesResult> {
  const [property] = await db.select().from(schema.properties).where(eq(schema.properties.id, input.propertyId));
  if (!property) return { ok: false, error: "not_found" };
  if (!HHMM.test(input.lateLatest) || !HHMM.test(input.earlyEarliest)) return { ok: false, error: "invalid" };
  // Later than the normal check-out, earlier than the normal check-in.
  if (input.lateLatest <= property.checkOutTime.slice(0, 5) || input.earlyEarliest >= property.checkInTime.slice(0, 5)) return { ok: false, error: "times" };
  await db.update(schema.properties).set({ guestLateCheckoutLatest: input.lateLatest, guestEarlyCheckinEarliest: input.earlyEarliest, updatedAt: new Date() }).where(eq(schema.properties.id, property.id));
  await audit(db, input.actor, property.id, "property", property.id, "rates.guest_times_updated", { lateLatest: input.lateLatest, earlyEarliest: input.earlyEarliest }, {
    lateLatest: property.guestLateCheckoutLatest.slice(0, 5),
    earlyEarliest: property.guestEarlyCheckinEarliest.slice(0, 5),
  });
  return { ok: true };
}
