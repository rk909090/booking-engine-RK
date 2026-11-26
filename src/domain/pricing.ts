import { addDays, diffDays, eachNight, isIsoDate } from "./dates";
import type { CancellationTier, Discount, LongStayTier, OfferTerms, PriceSnapshot, PricingTerms, RatePlan } from "./types";

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
  /** Friday and Saturday nights in this season; null uses the season's nightly rate. */
  weekendRate?: number | null;
  minStayNights: number | null;
};

export type PricingRules = {
  baseRate: number;
  /** Friday and Saturday nights outside every season; null uses the base rate. */
  weekendRate?: number | null;
  minStayNights: number;
  maxStayNights: number;
  seasons: Season[];
  /** Dates guests may not arrive on, [startDate, endDate). */
  arrivalClosures?: Array<{ startDate: string; endDate: string }>;
  taxRateBp: number;
  serviceRateBp: number;
  depositRateBp: number;
  balanceDueDays: number;
  /** Rate plans on offer besides the standard rate (null = not offered). */
  plans?: { nonRefundableBp: number | null; breakfastPerGuest: number | null };
  /** Automatic discounts. */
  offers?: { earlyBirdDays: number | null; earlyBirdBp: number | null; longStayTiers: LongStayTier[] };
};

/** A promo code that was checked against the stay (see domain/promos.ts). */
export type PromoOffer = { code: string; promoCodeId: string; discount: Discount; minNights: number | null };

export type QuoteOptions = {
  plan?: RatePlan;
  /** Guests counted for breakfast (adults and children). */
  guests?: number;
  promo?: PromoOffer | null;
};

export type StayRequest = {
  checkIn: string;
  checkOut: string;
  /** Today's date at the property (see todayIn). */
  today: string;
};

export type Quote = PriceSnapshot & {
  nightsCount: number;
  ratePlan: RatePlan;
  /** What to store on the booking so the same plan and offers apply when its dates change. */
  terms: PricingTerms;
  /** A valid promo code was given but a larger discount applied instead. */
  promoIgnored: boolean;
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
  | { kind: "max_stay"; maxNights: number }
  | { kind: "closed_to_arrival" }
  | { kind: "plan_unavailable" };

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

/** Rupiah a discount takes off the nights' subtotal (never more than the subtotal). */
export function discountAmountFor(subtotal: number, discount: Discount | null | undefined): number {
  if (!discount) return 0;
  const raw = discount.kind === "percent" ? applyBp(subtotal, discount.bp) : discount.amount;
  return Math.max(0, Math.min(subtotal, Math.round(raw)));
}

/** Whether a discount is well formed: 0–100% in basis points, or a whole, non-negative rupiah amount. */
export function validDiscount(discount: Discount): boolean {
  return discount.kind === "percent"
    ? Number.isInteger(discount.bp) && discount.bp > 0 && discount.bp <= 10_000
    : Number.isSafeInteger(discount.amount) && discount.amount > 0;
}

/** Service on the discounted nights (plus breakfast); tax on that plus service. */
function charges(subtotal: number, discount: number, serviceRateBp: number, taxRateBp: number, breakfast = 0) {
  const net = subtotal - discount + breakfast;
  const service = applyBp(net, serviceRateBp);
  const tax = applyBp(net + service, taxRateBp);
  return { service, tax, total: net + service + tax };
}

/** Friday and Saturday nights are weekend nights. */
export function isWeekendNight(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 5 || day === 6;
}

/** Today's price for one night: the season's (or base) rate, or its weekend rate on Friday and Saturday nights. */
export function nightlyRate(rules: PricingRules, date: string): PriceSnapshot["nights"][number] {
  const season = seasonFor(date, rules.seasons);
  const weekend = isWeekendNight(date);
  const rate = season
    ? (weekend ? (season.weekendRate ?? season.nightlyRate) : season.nightlyRate)
    : weekend
      ? (rules.weekendRate ?? rules.baseRate)
      : rules.baseRate;
  return { date, rate, season: season?.name ?? null };
}

export function closedToArrival(rules: PricingRules, checkIn: string): boolean {
  return (rules.arrivalClosures ?? []).some((c) => c.startDate <= checkIn && checkIn < c.endDate);
}

/** Rate plans a stay can be booked on (the standard rate is always offered). */
export function availablePlans(rules: PricingRules): RatePlan[] {
  const plans: RatePlan[] = ["standard"];
  if (rules.plans?.nonRefundableBp) plans.push("non_refundable");
  if (rules.plans?.breakfastPerGuest) plans.push("breakfast");
  return plans;
}

/**
 * The offers a new booking qualifies for, kept with it: early-bird when it is
 * made far enough ahead, every long-stay tier (each with its minimum nights,
 * so a later date change picks the right one) and a checked promo code.
 */
export function offerTerms(rules: PricingRules, daysUntilArrival: number, promo: PromoOffer | null | undefined): OfferTerms[] {
  const offers: OfferTerms[] = [];
  const o = rules.offers;
  if (promo) {
    offers.push({ kind: "promo", discount: promo.discount, code: promo.code, promoCodeId: promo.promoCodeId, ...(promo.minNights ? { minNights: promo.minNights } : {}) });
  }
  if (o?.earlyBirdDays && o.earlyBirdBp && daysUntilArrival >= o.earlyBirdDays) offers.push({ kind: "early_bird", discount: { kind: "percent", bp: o.earlyBirdBp } });
  for (const tier of o?.longStayTiers ?? []) offers.push({ kind: "long_stay", discount: { kind: "percent", bp: tier.bp }, minNights: tier.minNights });
  return offers;
}

type Settled = Pick<PriceSnapshot, "nights" | "subtotal" | "discount" | "ratePlan" | "planDiscount" | "offer" | "staffDiscount" | "breakfast" | "service" | "tax" | "total"> & {
  /** The offer that applied, if any. */
  applied: OfferTerms | null;
};

/**
 * The one pricing rule for every booking (owner's decision, 26 Nov 2026):
 * the plan's price first (non-refundable takes its share off the nights),
 * then only the single largest discount among the offers the booking
 * qualifies for and a staff discount. Breakfast is added on top; service and
 * tax are charged on the result.
 */
function settle(nights: PriceSnapshot["nights"], terms: PricingTerms, staff: Discount | null, serviceRateBp: number, taxRateBp: number): Settled {
  const subtotal = nights.reduce((sum, n) => sum + n.rate, 0);
  const planDiscount = terms.ratePlan === "non_refundable" && terms.planBp ? applyBp(subtotal, terms.planBp) : 0;
  const base = subtotal - planDiscount;
  let applied: OfferTerms | null = null;
  let offerAmount = 0;
  for (const offer of terms.offers ?? []) {
    if (offer.minNights && nights.length < offer.minNights) continue;
    const amount = discountAmountFor(base, offer.discount);
    if (amount > offerAmount) {
      applied = offer;
      offerAmount = amount;
    }
  }
  const staffAmount = discountAmountFor(base, staff);
  const staffWins = staffAmount > offerAmount;
  if (staffWins) applied = null;
  const best = staffWins ? staffAmount : offerAmount;
  const breakfast = terms.ratePlan === "breakfast" && terms.breakfastPerGuest ? terms.breakfastPerGuest * (terms.guests ?? 1) * nights.length : 0;
  const discount = planDiscount + best;
  return {
    nights,
    subtotal,
    discount,
    ratePlan: terms.ratePlan,
    ...(planDiscount ? { planDiscount } : {}),
    ...(applied && offerAmount ? { offer: { kind: applied.kind, ...(applied.code ? { code: applied.code } : {}), amount: offerAmount } } : {}),
    ...(staffWins && staffAmount ? { staffDiscount: staffAmount } : {}),
    ...(breakfast ? { breakfast } : {}),
    ...charges(subtotal, discount, serviceRateBp, taxRateBp, breakfast),
    applied,
  };
}

/** Minimum nights for a stay arriving on this date. */
export function minStayFor(rules: PricingRules, checkIn: string): number {
  return seasonFor(checkIn, rules.seasons)?.minStayNights ?? rules.minStayNights;
}

/**
 * Prices new dates for an existing booking. Nights the booking already had
 * keep the rate agreed at booking; only added nights use today's rates.
 * Service, tax, the plan and the offers are those saved with the booking
 * (an offer whose minimum nights is no longer met drops out).
 */
export function repriceStay(
  rules: PricingRules,
  previous: PriceSnapshot | null,
  checkIn: string,
  checkOut: string,
  discount: Discount | null = null,
  terms: PricingTerms | null = null,
): PriceSnapshot {
  const kept = new Map((previous?.nights ?? []).map((n) => [n.date, n]));
  const nights = eachNight(checkIn, checkOut).map((date) => kept.get(date) ?? nightlyRate(rules, date));
  const serviceRateBp = previous?.serviceRateBp ?? rules.serviceRateBp;
  const taxRateBp = previous?.taxRateBp ?? rules.taxRateBp;
  const { applied, ...price } = settle(nights, terms ?? { ratePlan: "standard" }, discount, serviceRateBp, taxRateBp);
  void applied;
  return { ...price, serviceRateBp, taxRateBp };
}

/**
 * Prices a stay. The minimum stay comes from the season of the arrival
 * night (or the villa type when no season applies), which is how most villa
 * operators phrase it: "minimum 5 nights for arrivals in high season".
 */
export function quoteStay(rules: PricingRules, stay: StayRequest, discount: Discount | null = null, options: QuoteOptions = {}): QuoteResult {
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
  if (closedToArrival(rules, checkIn)) return { ok: false, error: { kind: "closed_to_arrival" } };
  const plan = options.plan ?? "standard";
  if (!availablePlans(rules).includes(plan)) return { ok: false, error: { kind: "plan_unavailable" } };

  const daysUntilArrival = diffDays(today, checkIn);
  const terms: PricingTerms = {
    ratePlan: plan,
    ...(plan === "non_refundable" ? { planBp: rules.plans!.nonRefundableBp! } : {}),
    ...(plan === "breakfast" ? { breakfastPerGuest: rules.plans!.breakfastPerGuest!, guests: Math.max(1, options.guests ?? 1) } : {}),
  };
  const offers = offerTerms(rules, daysUntilArrival, options.promo);
  if (offers.length) terms.offers = offers;
  const nights = dates.map((date) => nightlyRate(rules, date));
  const { applied, ...price } = settle(nights, terms, discount, rules.serviceRateBp, rules.taxRateBp);

  // Non-refundable is paid in full at booking.
  const payInFull = plan === "non_refundable" || rules.depositRateBp >= 10_000 || daysUntilArrival <= rules.balanceDueDays;
  const dueNow = payInFull ? price.total : applyBp(price.total, rules.depositRateBp);

  return {
    ok: true,
    quote: {
      ...price,
      nightsCount: nights.length,
      ratePlan: plan,
      terms,
      promoIgnored: Boolean(options.promo) && applied?.kind !== "promo",
      serviceRateBp: rules.serviceRateBp,
      taxRateBp: rules.taxRateBp,
      dueNow,
      balance: price.total - dueNow,
      balanceDueDate: payInFull ? null : addDays(checkIn, -rules.balanceDueDays),
      payInFull,
    },
  };
}

/** The policy a non-refundable booking is held to: the whole stay is charged whenever it is cancelled. */
export const NON_REFUNDABLE_TIERS: CancellationTier[] = [{ minDaysBefore: 0, chargeBp: 10_000 }];

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

/** The price breakdown saved on a booking. */
export function snapshotOf(q: Quote): PriceSnapshot {
  return {
    nights: q.nights,
    subtotal: q.subtotal,
    discount: q.discount ?? 0,
    ratePlan: q.ratePlan,
    ...(q.planDiscount ? { planDiscount: q.planDiscount } : {}),
    ...(q.offer ? { offer: q.offer } : {}),
    ...(q.staffDiscount ? { staffDiscount: q.staffDiscount } : {}),
    ...(q.breakfast ? { breakfast: q.breakfast } : {}),
    service: q.service,
    tax: q.tax,
    total: q.total,
    serviceRateBp: q.serviceRateBp,
    taxRateBp: q.taxRateBp,
  };
}
