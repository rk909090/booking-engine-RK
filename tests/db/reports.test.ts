import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { cancelReservation, createHold, createPendingPayment, recordPaymentPaid } from "@/domain/booking";
import { setDiscount } from "@/domain/discount";
import { bookingsMade, loadReportData, lostBookings, netNights, performance, ratios, rollup, yearEarlier, type ReportReservation, type ReportUnit } from "@/domain/reports";
import { reportCsv } from "@/lib/ops/report-csv";
import { createTestDb, type TestDb } from "./test-db";

const RATE = 6_500_000;

describe("report maths", () => {
  const base: ReportReservation = {
    code: "A",
    propertyId: "p",
    unitId: "u1",
    status: "confirmed",
    source: "direct",
    checkIn: "2027-02-10",
    checkOut: "2027-02-12",
    subtotalAmount: 300,
    discountAmount: 31,
    extrasAmount: 0,
    amountPaid: 0,
    refundAmount: null,
    priceSnapshot: { nights: [{ date: "2027-02-10", rate: 100, season: null }, { date: "2027-02-11", rate: 200, season: null }], subtotal: 300, discount: 31, service: 0, tax: 0, total: 269, serviceRateBp: 0, taxRateBp: 0 },
    createdDate: "2027-01-20",
    cancelledDate: null,
    cancelledFromHold: false,
  };
  const units: ReportUnit[] = [
    { id: "u1", code: "V1", name: "V1", unitTypeId: "t1", typeName: "T1", propertyId: "p", propertyName: "P", isActive: true },
    { id: "u2", code: "V2", name: "V2", unitTypeId: "t1", typeName: "T1", propertyId: "p", propertyName: "P", isActive: true },
    { id: "u3", code: "V3", name: "V3", unitTypeId: "t2", typeName: "T2", propertyId: "p", propertyName: "P", isActive: false },
  ];

  it("spreads a discount over the nights by their rate, to the rupiah", () => {
    expect(netNights(base)).toEqual([{ date: "2027-02-10", net: 89 }, { date: "2027-02-11", net: 180 }]);
    // Without a snapshot the net price is split evenly.
    expect(netNights({ ...base, priceSnapshot: null, subtotalAmount: 301, discountAmount: 0 })).toEqual([{ date: "2027-02-10", net: 151 }, { date: "2027-02-11", net: 150 }]);
    // A stay shortened after booking only counts the nights still in it.
    expect(netNights({ ...base, checkOut: "2027-02-11" })).toEqual([{ date: "2027-02-10", net: 89 }]);
  });

  it("counts available nights of active villas minus maintenance, and sold nights and revenue on the nights stayed", () => {
    const perf = performance({
      from: "2027-02-11",
      to: "2027-02-12",
      units,
      blocks: [{ unitId: "u2", startDate: "2027-02-12", endDate: "2027-02-15" }],
      reservations: [base, { ...base, code: "H", status: "hold" }, { ...base, code: "X", status: "cancelled" }, { ...base, code: "E", extrasAmount: 50 }],
    });
    // u1: 2 nights, u2: 1 night (12th blocked), u3 inactive.
    expect(perf.totals).toEqual({ available: 3, sold: 2, revenue: 360, extras: 50 });
    expect(ratios(perf.totals)).toEqual({ occupancy: 2 / 3, adr: 180, revpar: 120 });
    expect(perf.bucket).toBe("day");
    expect(perf.series).toEqual([
      { key: "2027-02-11", available: 2, sold: 2, revenue: 360, extras: 50 },
      { key: "2027-02-12", available: 1, sold: 0, revenue: 0, extras: 0 },
    ]);
    expect(rollup(perf.byUnit, units, "unitTypeId").get("t1")?.available).toBe(3);
    expect(performance({ from: "2027-01-01", to: "2027-03-31", units, blocks: [], reservations: [] }).bucket).toBe("month");
  });

  it("counts bookings made by booking date, leaving out unpaid holds, with lead time and length of stay", () => {
    const made = bookingsMade({
      from: "2027-01-01",
      to: "2027-01-31",
      reservations: [
        base,
        { ...base, code: "B", source: "website", createdDate: "2027-01-31", checkIn: "2027-02-01", checkOut: "2027-02-05", priceSnapshot: null, discountAmount: 0 },
        { ...base, code: "H", status: "hold" },
        { ...base, code: "X", status: "expired" },
        { ...base, code: "C", status: "cancelled", cancelledFromHold: true },
        { ...base, code: "Old", createdDate: "2026-12-31" },
      ],
    });
    expect(made.rows.map((r) => r.code)).toEqual(["A", "B"]);
    expect(made).toMatchObject({ count: 2, nights: 6, value: 269 + 300, avgLeadDays: (21 + 1) / 2, avgNights: 3, discountedCount: 1, discountTotal: 31 });
    expect(made.bySource.get("website")).toEqual({ count: 1, nights: 4, value: 300 });
  });

  it("reports cancellations of confirmed bookings and no-shows with what was kept after refunds", () => {
    const lost = lostBookings({
      from: "2027-02-01",
      to: "2027-02-28",
      bookingsMadeCount: 4,
      reservations: [
        { ...base, code: "C1", status: "cancelled", cancelledDate: "2027-02-03", amountPaid: 200, refundAmount: 150 },
        { ...base, code: "C2", status: "cancelled", cancelledDate: "2027-02-04", cancelledFromHold: true },
        { ...base, code: "C3", status: "cancelled", cancelledDate: "2027-01-30" },
        { ...base, code: "N1", status: "no_show", amountPaid: 100 },
        { ...base, code: "S1", status: "checked_out" },
      ],
    });
    expect(lost.cancelled).toMatchObject({ count: 1, value: 269, kept: 50, rate: 0.25 });
    expect(lost.noShows).toMatchObject({ count: 1, value: 269, kept: 100, rate: 0.5 });
  });

  it("compares with the same dates a year earlier", () => {
    expect(yearEarlier("2027-02-10")).toBe("2026-02-10");
    expect(yearEarlier("2028-02-29")).toBe("2027-02-28");
  });

  it("exports plain numbers without guest names and defuses spreadsheet formulas", () => {
    const perf = performance({ from: "2027-02-10", to: "2027-02-11", units, blocks: [], reservations: [base] });
    const report = {
      units: [{ ...units[0], propertyName: "=HYPERLINK(1)" }, units[1]],
      current: { perf, made: bookingsMade({ from: "2027-01-01", to: "2027-01-31", reservations: [base] }), lost: lostBookings({ from: "2027-02-01", to: "2027-02-28", reservations: [], bookingsMadeCount: 0 }) },
    };
    const villas = reportCsv(report, "villas");
    expect(villas.startsWith("﻿property,villa_type,villa,available_nights")).toBe(true);
    expect(villas).toContain("'=HYPERLINK(1),T1,V1,2,2,100.0,269,135,135,0");
    expect(reportCsv(report, "bookings")).toContain("A,'=HYPERLINK(1),V1,2027-01-20,direct,2027-02-10,2027-02-12,2,21,269,31,confirmed");
  });
});

describe("report data from the database", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let propertyId: string;
  let typeId: string;
  let unitIds: string[];

  beforeAll(async () => {
    const test = await createTestDb();
    db = test.db;
    close = () => test.client.close();
    await seedSampleData(db);
    const [type] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.slug, "river-pavilion"));
    typeId = type.id;
    propertyId = type.propertyId;
    unitIds = (await db.select().from(schema.units).where(eq(schema.units.unitTypeId, typeId)).orderBy(schema.units.code)).map((u) => u.id);
  });
  afterAll(async () => close());
  beforeEach(async () => {
    for (const table of [schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests]) await db.delete(table);
    await db.update(schema.properties).set({ serviceRateBp: 1000, taxRateBp: 1000 }).where(eq(schema.properties.id, propertyId));
  });

  async function hold(unit: number, when: Date, ci = "2027-02-10", co = "2027-02-12") {
    const h = await createHold(db, {
      unitTypeId: typeId, checkIn: ci, checkOut: co, adults: 2, children: 0,
      guest: { fullName: "G", email: "g@example.com" }, locale: "en", source: "website", now: when, candidateUnitIds: [unitIds[unit]],
    });
    if (!h.ok) throw new Error(JSON.stringify(h.error));
    return h.reservation;
  }
  async function pay(r: { id: string; code: string; totalAmount: number }, when: Date) {
    await createPendingPayment(db, { reservationId: r.id, provider: "simulated", providerRef: `ref-${r.code}`, purpose: "full", amount: r.totalAmount, checkoutUrl: null, expiresAt: null });
    await recordPaymentPaid(db, { provider: "simulated", providerRef: `ref-${r.code}`, amount: r.totalAmount, paidAt: when });
  }

  it("uses the property's dates, net room revenue without tax and service, and tells cancelled holds apart", async () => {
    // 20:00 UTC on 1 Jan is already 2 Jan in Bali.
    const late = new Date("2027-01-01T20:00:00Z");
    const a = await hold(0, late);
    await pay(a, late);
    await setDiscount(db, { reservationId: a.id, discount: { kind: "percent", bp: 1000 }, reason: "Repeat", role: "branch_manager", actor: { type: "staff", id: "bm" }, now: late });
    const b = await hold(1, late);
    await cancelReservation(db, { reservationId: b.id, actor: { type: "guest" }, now: late });
    const c = await hold(2, late);
    await pay(c, late);
    await cancelReservation(db, { reservationId: c.id, actor: { type: "guest" }, now: new Date("2027-01-03T03:00:00Z") });

    const data = await loadReportData(db, { propertyIds: [propertyId], from: "2027-01-01", to: "2027-02-28" });
    const byCode = new Map(data.reservations.map((r) => [r.code, r]));
    expect(byCode.get(a.code)).toMatchObject({ createdDate: "2027-01-02", status: "confirmed", cancelledFromHold: false });
    expect(byCode.get(b.code)).toMatchObject({ status: "cancelled", cancelledFromHold: true, cancelledDate: "2027-01-02" });
    expect(byCode.get(c.code)).toMatchObject({ status: "cancelled", cancelledFromHold: false, cancelledDate: "2027-01-03" });

    const perf = performance({ from: "2027-02-10", to: "2027-02-11", ...data });
    // Ubud has 5 active villas; one booking of 2 nights at 6.5M less 10%, without the 10% service and tax.
    expect(perf.totals).toMatchObject({ available: 10, sold: 2, revenue: 2 * RATE * 0.9 });
    const made = bookingsMade({ from: "2027-01-01", to: "2027-01-31", reservations: data.reservations });
    expect(made.rows.map((r) => r.code).sort()).toEqual([a.code, c.code].sort());
    const lost = lostBookings({ from: "2027-01-01", to: "2027-01-31", reservations: data.reservations, bookingsMadeCount: made.count });
    expect(lost.cancelled.rows.map((r) => r.code)).toEqual([c.code]);
  });
});
