import { describe, expect, it } from "vitest";
import { paceCsv } from "@/lib/ops/report-csv";
import { onBooksAsOf, onTheBooks, performance, type ReportReservation, type ReportUnit } from "./reports";

const units: ReportUnit[] = [
  { id: "u1", code: "V1", name: "V1", unitTypeId: "t", typeName: "T", propertyId: "p", propertyName: "P", isActive: true },
  { id: "u2", code: "V2", name: "V2", unitTypeId: "t", typeName: "T", propertyId: "p", propertyName: "P", isActive: true },
];
const r = (over: Partial<ReportReservation>): ReportReservation => ({
  code: "A",
  propertyId: "p",
  unitId: "u1",
  status: "confirmed",
  source: "direct",
  checkIn: "2027-03-10",
  checkOut: "2027-03-12",
  subtotalAmount: 200,
  discountAmount: 0,
  extrasAmount: 0,
  amountPaid: 0,
  refundAmount: null,
  priceSnapshot: null,
  createdDate: "2027-01-10",
  cancelledDate: null,
  cancelledFromHold: false,
  ...over,
});

describe("on the books", () => {
  it("counts a booking from the day it was made until the day it was cancelled; unpaid holds never", () => {
    expect(onBooksAsOf(r({}), "2027-01-09")).toBe(false);
    expect(onBooksAsOf(r({}), "2027-01-10")).toBe(true);
    const cancelled = r({ status: "cancelled", cancelledDate: "2027-02-01" });
    expect(onBooksAsOf(cancelled, "2027-01-31")).toBe(true);
    expect(onBooksAsOf(cancelled, "2027-02-01")).toBe(false);
    expect(onBooksAsOf(r({ status: "cancelled", cancelledDate: "2027-02-01", cancelledFromHold: true }), "2027-01-31")).toBe(false);
    expect(onBooksAsOf(r({ status: "hold" }), "2027-02-01")).toBe(false);
    expect(onBooksAsOf(r({ status: "expired" }), "2027-02-01")).toBe(false);
    // Stays that already happened were on the books before they happened, no-shows included.
    expect(onBooksAsOf(r({ status: "no_show" }), "2027-02-01")).toBe(true);
    expect(onBooksAsOf(r({ status: "checked_out" }), "2027-02-01")).toBe(true);
  });

  it("adds up the nights on the books per stay month, and the pickup is the change since a week ago", () => {
    const reservations = [
      r({}),
      r({ code: "B", unitId: "u2", checkIn: "2027-04-01", checkOut: "2027-04-04", subtotalAmount: 300, createdDate: "2027-02-27" }),
      r({ code: "C", unitId: "u2", status: "cancelled", cancelledDate: "2027-02-26", createdDate: "2027-01-05" }),
    ];
    const input = { from: "2027-03-01", to: "2027-04-30", units, blocks: [], reservations };
    const now = onTheBooks({ asOf: "2027-03-01", ...input });
    expect(now.series).toEqual([
      { key: "2027-03", available: 62, sold: 2, revenue: 200, extras: 0 },
      { key: "2027-04", available: 60, sold: 3, revenue: 300, extras: 0 },
    ]);
    const weekAgo = onTheBooks({ asOf: "2027-02-22", ...input });
    // A week ago: A and C (not cancelled yet); B not made yet.
    expect(weekAgo.series.map((s) => s.sold)).toEqual([4, 0]);

    const lyFinal = performance({ ...input, from: "2026-03-01", to: "2026-04-30", bucket: "month", reservations: [r({ checkIn: "2026-03-05", checkOut: "2026-03-06", subtotalAmount: 90, createdDate: "2026-01-01" })] });
    const stly = onTheBooks({ asOf: "2026-03-01", from: "2026-03-01", to: "2026-04-30", units, blocks: [], reservations: [] });
    const csv = paceCsv({ current: now, weekAgo, stly, lyFinal });
    expect(csv).toContain("2027-03,62,2,3.2,200,100,-2,-200,0,0,1,90");
    expect(csv).toContain("2027-04,60,3,5.0,300,100,3,300,0,0,0,0");
  });
});
