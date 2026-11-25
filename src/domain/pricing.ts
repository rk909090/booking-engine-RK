import { addDays, diffDays, eachNight, isIsoDate } from "./dates";
import type { CancellationTier, PriceSnapshot } from "./types";

/*
 * Pure pricing rules. No database access: everything needed is passed in,
 * so the same function prices the search results, the checkout and the
 * reservation, and is easy to test exhaustively.
 *
 * Money is whole rupiah. Percentages are basis points (10000 = 100%).
 */

export type Season = {
  name: string;
  startDate: string;
  endDate: string;
  nightlyRate: number;
  minStayNights: number | null;
};

export type PricingRules = {
  baseRate: number;
  minStayNights: number;
  maxStayNights: number;
  seasons: Season[];
  taxRateBp: number;
  serviceRateBp: number;
  depositRateBp: number;
  balanceDueDays: number;
};

export type StayRequest = {
  checkIn: string;
  checkOut: string;
  /** Today's date at the property (see todayIn). */
  today: string;
};

export type Quote = PriceSnapshot & {
  nightsCount: number;
  /** Due now: the deposit, or the whole total when paying in full. */
  dueNow: number;
  /** Due later; 0 when paying in full. */
  balance: number;
  balanceDueDate: string | null;
  payInFull: boolean;
};

export type QuoteError =
  | { kind: "invalid_dates" }
  | { kind: "check_in_in_past" }
  | { kind: "min_stay"; minNights: number }
  | { kind: "max_stay"; maxNights: number };

export type QuoteResult = { ok: true; quote: Quote } | { ok: false; error: QuoteError };

/**
 * Still to pay on a booking: the total minus what was paid, plus any refund
 * owed back to the guest (that money is not kept, so it does not count).
 */
export function balanceDue(r: { totalAmount: number; amountPaid: number; refundAmount: number | null }): number {
  return r.totalAmount - r.amountPaid + (r.refundAmount ?? 0);
}

/** Rounds a basis-point share of an amount to the nearest rupiah. */
export function applyBp(amount: number, bp: number): number {
  return Math.round((amount * bp) / 10_000);
}

function seasonFor(date: string, seasons: Season[]): Season | undefined {
  return seasons.find((s) => s.startDate <= date && date < s.endDate);
}

/** Today's price for one night. */
export function nightlyRate(rules: PricingRules, date: string): PriceSnapshot["nights"][number] {
  const season = seasonFor(date, rules.seasons);
  return { date, rate: season?.nightlyRate ?? rules.baseRate, season: season?.name ?? null };
}

/** Minimum nights for a stay arriving on this date. */
export function minStayFor(rules: PricingRules, checkIn: string): number {
  return seasonFor(checkIn, rules.seasons)?.minStayNights ?? rules.minStayNights;
}

/**
 * Prices new dates for an existing booking. Nights the booking already had
 * keep the rate agreed at booking; only added nights use today's rates.
 * Service and tax use the rates saved with the booking.
 */
export function repriceStay(rules: PricingRules, previous: PriceSnapshot | null, checkIn: string, checkOut: string): PriceSnapshot {
  const kept = new Map((previous?.nights ?? []).map((n) => [n.date, n]));
  const nights = eachNight(checkIn, checkOut).map((date) => kept.get(date) ?? nightlyRate(rules, date));
  const serviceRateBp = previous?.serviceRateBp ?? rules.serviceRateBp;
  const taxRateBp = previous?.taxRateBp ?? rules.taxRateBp;
  const subtotal = nights.reduce((sum, n) => sum + n.rate, 0);
  const service = applyBp(subtotal, serviceRateBp);
  const tax = applyBp(subtotal + service, taxRateBp);
  return { nights, subtotal, service, tax, total: subtotal + service + tax, serviceRateBp, taxRateBp };
}

/**
 * Prices a stay. The minimum stay comes from the season of the arrival
 * night (or the villa type when no season applies), which is how most villa
 * operators phrase it: "minimum 5 nights for arrivals in high season".
 */
export function quoteStay(rules: PricingRules, stay: StayRequest): QuoteResult {
  const { checkIn, checkOut, today } = stay;
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut) || !isIsoDate(today) || checkOut <= checkIn) {
    return { ok: false, error: { kind: "invalid_dates" } };
  }
  if (checkIn < today) return { ok: false, error: { kind: "check_in_in_past" } };

  const dates = eachNight(checkIn, checkOut);
  const minNights = minStayFor(rules, checkIn);
  if (dates.length < minNights) return { ok: false, error: { kind: "min_stay", minNights } };
  if (dates.length > rules.maxStayNights) {
    return { ok: false, error: { kind: "max_stay", maxNights: rules.maxStayNights } };
  }

  const nights = dates.map((date) => nightlyRate(rules, date));
  const subtotal = nights.reduce((sum, n) => sum + n.rate, 0);
  // Service charge on the room rate; tax on room rate plus service.
  const service = applyBp(subtotal, rules.serviceRateBp);
  const tax = applyBp(subtotal + service, rules.taxRateBp);
  const total = subtotal + service + tax;

  const daysUntilArrival = diffDays(today, checkIn);
  const payInFull = rules.depositRateBp >= 10_000 || daysUntilArrival <= rules.balanceDueDays;
  const dueNow = payInFull ? total : applyBp(total, rules.depositRateBp);

  return {
    ok: true,
    quote: {
      nights,
      nightsCount: nights.length,
      subtotal,
      service,
      tax,
      total,
      serviceRateBp: rules.serviceRateBp,
      taxRateBp: rules.taxRateBp,
      dueNow,
      balance: total - dueNow,
      balanceDueDate: payInFull ? null : addDays(checkIn, -rules.balanceDueDays),
      payInFull,
    },
  };
}

export type CancellationOutcome = {
  daysBeforeArrival: number;
  /** Fee kept under the policy, capped at what was paid. */
  fee: number;
  refund: number;
};

/**
 * What cancelling costs. The fee is a share of the stay total chosen by how
 * many days remain before check-in; the guest gets back whatever they paid
 * above that fee. Without a matching tier (cancelling after check-in day)
 * the whole stay is charged.
 */
export function cancellationOutcome(args: {
  tiers: CancellationTier[];
  total: number;
  amountPaid: number;
  checkIn: string;
  today: string;
}): CancellationOutcome {
  const daysBeforeArrival = diffDays(args.today, args.checkIn);
  const tier = [...args.tiers]
    .sort((a, b) => b.minDaysBefore - a.minDaysBefore)
    .find((t) => daysBeforeArrival >= t.minDaysBefore);
  const charge = tier ? applyBp(args.total, tier.chargeBp) : args.total;
  const fee = Math.min(charge, args.amountPaid);
  return { daysBeforeArrival, fee, refund: Math.max(0, args.amountPaid - charge) };
}
