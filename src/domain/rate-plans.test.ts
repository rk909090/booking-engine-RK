import { describe, expect, it } from "vitest";
import { isWeekendNight, quoteStay, repriceStay, type PricingRules, type PromoOffer, type Quote } from "./pricing";

/*
 * Rate plans, weekend rates, closed-to-arrival dates and the single-best
 * discount rule (owner's decisions, 26 Nov 2026).
 * 2027-02-10 is a Wednesday, so 12 and 13 Feb are Friday and Saturday nights.
 */

const base: PricingRules = {
  baseRate: 6_500_000,
  minStayNights: 2,
  maxStayNights: 30,
  seasons: [{ name: "High", startDate: "2026-12-20", endDate: "2027-01-05", nightlyRate: 9_000_000, weekendRate: 11_000_000, minStayNights: 5 }],
  taxRateBp: 0,
  serviceRateBp: 0,
  depositRateBp: 3000,
  balanceDueDays: 14,
};
const today = "2026-11-25";

function quote(rules: PricingRules, checkIn: string, checkOut: string, ...rest: Parameters<typeof quoteStay> extends [unknown, unknown, ...infer R] ? R : never): Quote {
  const r = quoteStay(rules, { checkIn, checkOut, today }, ...rest);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.quote;
}

describe("weekend rates and closed arrivals", () => {
  it("charges the weekend rate on Friday and Saturday nights, in and out of season", () => {
    expect(["2027-02-12", "2027-02-13"].every(isWeekendNight)).toBe(true);
    expect(isWeekendNight("2027-02-14")).toBe(false);
    const q = quote({ ...base, weekendRate: 8_000_000 }, "2027-02-10", "2027-02-14");
    expect(q.nights.map((n) => n.rate)).toEqual([6_500_000, 6_500_000, 8_000_000, 8_000_000]);
    // 24 Dec 2026 is a Thursday; the season has its own weekend rate.
    const high = quote(base, "2026-12-24", "2026-12-29");
    expect(high.nights.map((n) => n.rate)).toEqual([9_000_000, 11_000_000, 11_000_000, 9_000_000, 9_000_000]);
  });

  it("refuses arrivals on closed dates but lets stays run over them", () => {
    const rules = { ...base, arrivalClosures: [{ startDate: "2027-03-10", endDate: "2027-03-12" }] };
    expect(quoteStay(rules, { checkIn: "2027-03-10", checkOut: "2027-03-13", today })).toEqual({ ok: false, error: { kind: "closed_to_arrival" } });
    expect(quoteStay(rules, { checkIn: "2027-03-11", checkOut: "2027-03-13", today }).ok).toBe(false);
    expect(quoteStay(rules, { checkIn: "2027-03-12", checkOut: "2027-03-14", today }).ok).toBe(true);
    expect(quoteStay(rules, { checkIn: "2027-03-09", checkOut: "2027-03-13", today }).ok).toBe(true);
  });
});

describe("rate plans", () => {
  const rules: PricingRules = { ...base, serviceRateBp: 1000, taxRateBp: 1000, plans: { nonRefundableBp: 1000, breakfastPerGuest: 250_000 } };

  it("non-refundable takes its share off the nights and is paid in full", () => {
    const q = quote(rules, "2027-03-01", "2027-03-04", null, { plan: "non_refundable" });
    expect(q).toMatchObject({ ratePlan: "non_refundable", subtotal: 19_500_000, planDiscount: 1_950_000, discount: 1_950_000, payInFull: true, balanceDueDate: null });
    // Service on 17,550,000 = 1,755,000; tax on 19,305,000 = 1,930,500.
    expect(q.total).toBe(17_550_000 + 1_755_000 + 1_930_500);
    expect(q.dueNow).toBe(q.total);
    expect(q.terms).toEqual({ ratePlan: "non_refundable", planBp: 1000 });
  });

  it("breakfast adds a price per guest per night before service and tax", () => {
    const q = quote(rules, "2027-03-01", "2027-03-04", null, { plan: "breakfast", guests: 3 });
    expect(q.breakfast).toBe(250_000 * 3 * 3);
    const net = 19_500_000 + 2_250_000;
    expect(q.total).toBe(net + Math.round(net * 0.1) + Math.round(net * 1.1 * 0.1));
    expect(q.payInFull).toBe(false);
  });

  it("refuses a plan the property does not offer", () => {
    expect(quoteStay(base, { checkIn: "2027-03-01", checkOut: "2027-03-04", today }, null, { plan: "breakfast" })).toEqual({ ok: false, error: { kind: "plan_unavailable" } });
  });
});

describe("only the single largest discount applies", () => {
  const rules: PricingRules = {
    ...base,
    plans: { nonRefundableBp: 1000, breakfastPerGuest: null },
    offers: { earlyBirdDays: 60, earlyBirdBp: 1000, longStayTiers: [{ minNights: 7, bp: 1500 }, { minNights: 14, bp: 2000 }] },
  };
  const promo = (discount: PromoOffer["discount"], minNights: number | null = null): PromoOffer => ({ code: "BALI", promoCodeId: "p1", discount, minNights });

  it("early-bird beats a smaller promo, which is then reported as not used", () => {
    // 3 nights, 96 days ahead: early-bird 10% of 19,500,000 = 1,950,000 beats Rp 1,000,000.
    const q = quote(rules, "2027-03-01", "2027-03-04", null, { promo: promo({ kind: "amount", amount: 1_000_000 }) });
    expect(q.offer).toEqual({ kind: "early_bird", amount: 1_950_000 });
    expect(q.promoIgnored).toBe(true);
    expect(q.discount).toBe(1_950_000);
  });

  it("a larger promo wins and is kept on the booking", () => {
    const q = quote(rules, "2027-03-01", "2027-03-04", null, { promo: promo({ kind: "percent", bp: 2500 }) });
    expect(q.offer).toEqual({ kind: "promo", code: "BALI", amount: 4_875_000 });
    expect(q.promoIgnored).toBe(false);
  });

  it("long stays get the highest tier reached; close-in bookings get no early-bird", () => {
    expect(quote(rules, "2027-03-01", "2027-03-08").offer).toEqual({ kind: "long_stay", amount: 6_825_000 });
    expect(quote(rules, "2027-03-01", "2027-03-15").offer?.amount).toBe(Math.round(14 * 6_500_000 * 0.2));
    expect(quote(rules, "2026-12-10", "2026-12-13").offer).toBeUndefined();
  });

  it("combines the non-refundable plan with the best offer, taken on the plan's price", () => {
    const q = quote(rules, "2027-03-01", "2027-03-04", null, { plan: "non_refundable" });
    expect(q.planDiscount).toBe(1_950_000);
    expect(q.offer).toEqual({ kind: "early_bird", amount: 1_755_000 });
    expect(q.discount).toBe(3_705_000);
  });

  it("a staff discount competes too: it applies only when it is the largest", () => {
    const bigger = quote(rules, "2027-03-01", "2027-03-08", { kind: "percent", bp: 2000 });
    expect(bigger.staffDiscount).toBe(9_100_000);
    expect(bigger.offer).toBeUndefined();
    const smaller = quote(rules, "2027-03-01", "2027-03-08", { kind: "percent", bp: 500 });
    expect(smaller.staffDiscount).toBeUndefined();
    expect(smaller.offer?.kind).toBe("long_stay");
  });

  it("re-applies the saved offers when the dates change", () => {
    const booked = quote(rules, "2027-03-01", "2027-03-08", null, { plan: "non_refundable" });
    const snapshot = { ...booked, serviceRateBp: 0, taxRateBp: 0 };
    // Shortened below 7 nights: the long-stay tier drops out and early-bird (kept from booking) applies.
    const shorter = repriceStay(rules, snapshot, "2027-03-01", "2027-03-06", null, booked.terms);
    expect(shorter.offer?.kind).toBe("early_bird");
    expect(shorter.planDiscount).toBe(Math.round(5 * 6_500_000 * 0.1));
    // Extended to 14 nights: the 20% tier applies.
    const longer = repriceStay(rules, snapshot, "2027-03-01", "2027-03-15", null, booked.terms);
    expect(longer.offer).toEqual({ kind: "long_stay", amount: Math.round(14 * 6_500_000 * 0.9 * 0.2) });
    // Bookings made before rate plans existed reprice as before.
    expect(repriceStay(rules, snapshot, "2027-03-01", "2027-03-06").discount).toBe(0);
  });
});
