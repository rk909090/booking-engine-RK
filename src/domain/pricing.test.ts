import { describe, expect, it } from "vitest";
import { addDays, diffDays, eachNight, isIsoDate, todayIn } from "./dates";
import { applyBp, cancellationOutcome, quoteStay, type PricingRules } from "./pricing";
import { SAMPLE_CANCELLATION_TIERS } from "./types";

const rules: PricingRules = {
  baseRate: 6_500_000,
  minStayNights: 2,
  maxStayNights: 30,
  seasons: [
    { name: "High", startDate: "2026-12-20", endDate: "2027-01-05", nightlyRate: 9_000_000, minStayNights: 5 },
  ],
  taxRateBp: 0,
  serviceRateBp: 0,
  depositRateBp: 3000,
  balanceDueDays: 14,
};

describe("dates", () => {
  it("validates real calendar dates only", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("26-01-01")).toBe(false);
  });

  it("adds and diffs days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-03-01", -1)).toBe("2027-02-28");
    expect(diffDays("2026-12-28", "2027-01-02")).toBe(5);
    expect(eachNight("2026-12-30", "2027-01-02")).toEqual(["2026-12-30", "2026-12-31", "2027-01-01"]);
  });

  it("gives today's date in Bali time, not the server's", () => {
    // 17:00 UTC on 24 Nov is 01:00 on 25 Nov in Bali (UTC+8).
    expect(todayIn("Asia/Makassar", new Date("2026-11-24T17:00:00Z"))).toBe("2026-11-25");
    expect(todayIn("UTC", new Date("2026-11-24T17:00:00Z"))).toBe("2026-11-24");
  });
});

describe("quoteStay", () => {
  const today = "2026-11-25";

  it("prices base-rate nights and splits deposit and balance", () => {
    const r = quoteStay(rules, { checkIn: "2027-02-10", checkOut: "2027-02-13", today });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.quote.nightsCount).toBe(3);
    expect(r.quote.total).toBe(19_500_000);
    expect(r.quote.payInFull).toBe(false);
    expect(r.quote.dueNow).toBe(5_850_000);
    expect(r.quote.balance).toBe(13_650_000);
    expect(r.quote.balanceDueDate).toBe("2027-01-27");
  });

  it("uses the seasonal rate per night when a stay crosses into a season", () => {
    const r = quoteStay(rules, { checkIn: "2026-12-17", checkOut: "2026-12-22", today });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.quote.nights.map((n) => n.rate)).toEqual([6_500_000, 6_500_000, 6_500_000, 9_000_000, 9_000_000]);
    expect(r.quote.nights.map((n) => n.season)).toEqual([null, null, null, "High", "High"]);
  });

  it("applies the arrival season's minimum stay", () => {
    expect(quoteStay(rules, { checkIn: "2026-12-22", checkOut: "2026-12-25", today })).toEqual({
      ok: false,
      error: { kind: "min_stay", minNights: 5 },
    });
    expect(quoteStay(rules, { checkIn: "2027-02-10", checkOut: "2027-02-11", today })).toEqual({
      ok: false,
      error: { kind: "min_stay", minNights: 2 },
    });
  });

  it("rejects bad, past and over-long stays", () => {
    expect(quoteStay(rules, { checkIn: "2027-02-10", checkOut: "2027-02-10", today }).ok).toBe(false);
    expect(quoteStay(rules, { checkIn: "2027-02-31", checkOut: "2027-03-02", today }).ok).toBe(false);
    expect(quoteStay(rules, { checkIn: "2026-11-24", checkOut: "2026-11-27", today })).toEqual({
      ok: false,
      error: { kind: "check_in_in_past" },
    });
    expect(quoteStay(rules, { checkIn: "2027-02-01", checkOut: "2027-03-05", today })).toEqual({
      ok: false,
      error: { kind: "max_stay", maxNights: 30 },
    });
  });

  it("asks for the full amount when arrival is within the balance window", () => {
    const r = quoteStay(rules, { checkIn: "2026-12-05", checkOut: "2026-12-08", today });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.quote.payInFull).toBe(true);
    expect(r.quote.dueNow).toBe(r.quote.total);
    expect(r.quote.balanceDueDate).toBeNull();
  });

  it("adds service on the room rate and tax on room plus service", () => {
    const r = quoteStay(
      { ...rules, serviceRateBp: 1000, taxRateBp: 1000 },
      { checkIn: "2027-02-10", checkOut: "2027-02-12", today },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.quote.subtotal).toBe(13_000_000);
    expect(r.quote.service).toBe(1_300_000);
    expect(r.quote.tax).toBe(1_430_000);
    expect(r.quote.total).toBe(15_730_000);
  });

  it("keeps its sums consistent for many random stays", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 500; i += 1) {
      const checkIn = addDays(today, Math.floor(rand() * 120));
      const checkOut = addDays(checkIn, 1 + Math.floor(rand() * 20));
      const r = quoteStay(
        {
          ...rules,
          minStayNights: 1,
          serviceRateBp: Math.floor(rand() * 2000),
          taxRateBp: Math.floor(rand() * 2000),
          depositRateBp: Math.floor(rand() * 10001),
        },
        { checkIn, checkOut, today },
      );
      if (!r.ok) {
        expect(r.error.kind).toBe("min_stay");
        continue;
      }
      const q = r.quote;
      expect(q.nights.reduce((s, n) => s + n.rate, 0)).toBe(q.subtotal);
      expect(q.subtotal + q.service + q.tax).toBe(q.total);
      expect(q.dueNow + q.balance).toBe(q.total);
      expect(q.dueNow).toBeGreaterThanOrEqual(0);
      expect(q.balance).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(q.total) && Number.isInteger(q.dueNow)).toBe(true);
    }
  });
});

describe("cancellationOutcome", () => {
  const base = { tiers: SAMPLE_CANCELLATION_TIERS, total: 20_000_000, checkIn: "2027-02-10" };

  it("refunds everything 14 or more days before arrival", () => {
    expect(cancellationOutcome({ ...base, amountPaid: 6_000_000, today: "2027-01-27" })).toEqual({
      daysBeforeArrival: 14,
      fee: 0,
      refund: 6_000_000,
    });
  });

  it("charges half the stay 7 to 13 days before, keeping at most what was paid", () => {
    expect(cancellationOutcome({ ...base, amountPaid: 20_000_000, today: "2027-02-01" })).toEqual({
      daysBeforeArrival: 9,
      fee: 10_000_000,
      refund: 10_000_000,
    });
    expect(cancellationOutcome({ ...base, amountPaid: 6_000_000, today: "2027-02-01" })).toEqual({
      daysBeforeArrival: 9,
      fee: 6_000_000,
      refund: 0,
    });
  });

  it("charges the full stay inside 7 days and after arrival", () => {
    expect(cancellationOutcome({ ...base, amountPaid: 20_000_000, today: "2027-02-08" }).refund).toBe(0);
    expect(cancellationOutcome({ ...base, amountPaid: 20_000_000, today: "2027-02-12" }).refund).toBe(0);
  });

  it("rounds shares to whole rupiah", () => {
    expect(applyBp(1_000_001, 3000)).toBe(300_000);
    expect(applyBp(5, 5000)).toBe(3);
  });
});
