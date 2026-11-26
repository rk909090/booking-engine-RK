import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { createAddon } from "@/domain/addons";
import { cancelReservation, createHold, createPendingPayment, recordPaymentPaid, type HoldInput } from "@/domain/booking";
import { approveDateChange, cancelDateChangeAsGuest, declineDateChange, previewGuestDateChange, requestDateChangeAsGuest } from "@/domain/date-change";
import { cancelEarlyCheckinAsGuest, guestEarlyCheckin, guestEarlyCheckinTimes, requestEarlyCheckinAsGuest } from "@/domain/early-checkin";
import { guestLateCheckout, guestLateCheckoutTimes } from "@/domain/late-checkout";
import { updateGuestTimes } from "@/domain/rates";
import { createTestDb, type TestDb } from "./test-db";

// 03:00 UTC = 11:00 in Bali.
const at = (date: string, utc = "03:00") => new Date(`${date}T${utc}:00Z`);
const RATE = 6_500_000;
const staff = { type: "staff" as const, id: "bm-1" };

let db: TestDb;
let close: () => Promise<void>;
let typeId: string;
let propertyId: string;
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
  for (const table of [schema.dateChangeRequests, schema.addonOrders, schema.addons, schema.tasks, schema.folioCharges, schema.earlyCheckinRequests, schema.lateCheckoutRequests, schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests]) await db.delete(table);
  await db.update(schema.properties).set({ guestLateCheckoutLatest: "18:00", guestEarlyCheckinEarliest: "10:00" }).where(eq(schema.properties.id, propertyId));
});

async function booked(unit: number, checkIn: string, checkOut: string, extra: Partial<HoldInput> = {}, now = at("2027-01-05")) {
  const h = await createHold(db, { unitTypeId: typeId, checkIn, checkOut, adults: 2, children: 0, guest: { fullName: "Guest", email: `g${unit}${checkIn}@example.com` }, locale: "en", source: "website", now, candidateUnitIds: [unitIds[unit]], ...extra });
  if (!h.ok) throw new Error(JSON.stringify(h.error));
  const amount = h.reservation.depositAmount;
  await createPendingPayment(db, { reservationId: h.reservation.id, provider: "simulated", providerRef: `q-${h.reservation.code}`, purpose: "full", amount, checkoutUrl: null, expiresAt: null });
  await recordPaymentPaid(db, { provider: "simulated", providerRef: `q-${h.reservation.code}`, amount, paidAt: now });
  return (await db.select().from(schema.reservations).where(eq(schema.reservations.id, h.reservation.id)))[0];
}

describe("guest times set per property", () => {
  it("offers early check-in from the property's earliest time (or after the leaving guest plus turnover) up to check-in", async () => {
    expect(guestEarlyCheckinTimes({ standardCheckIn: "14:00", earliestAllowed: null, guestEarliest: "10:00", nowTime: null })).toEqual(["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30"]);
    // Previous guest leaves 11:00, turnover 2h: from 13:00.
    expect(guestEarlyCheckinTimes({ standardCheckIn: "14:00", earliestAllowed: "13:00", guestEarliest: "10:00", nowTime: null })).toEqual(["13:00", "13:30"]);
    expect(guestEarlyCheckinTimes({ standardCheckIn: "14:00", earliestAllowed: null, guestEarliest: "10:00", nowTime: "12:10" })).toEqual(["12:30", "13:00", "13:30"]);
    expect(guestLateCheckoutTimes({ standardCheckOut: "11:00", latestAllowed: null, nowTime: null, guestLatest: "13:00" })).toEqual(["11:30", "12:00", "12:30", "13:00"]);

    expect(await updateGuestTimes(db, { propertyId, lateLatest: "10:00", earlyEarliest: "09:00", actor: staff })).toEqual({ ok: false, error: "times" });
    expect(await updateGuestTimes(db, { propertyId, lateLatest: "15:00", earlyEarliest: "12:00", actor: staff })).toEqual({ ok: true });
    const r = await booked(0, "2027-02-10", "2027-02-12");
    expect((await guestLateCheckout(db, r.id, at("2027-01-06")))?.times.at(-1)).toBe("15:00");
    expect((await guestEarlyCheckin(db, r.id, at("2027-01-06")))?.times[0]).toBe("12:00");
  });

  it("lets a guest ask to arrive early, withdraw, and ask again", async () => {
    const r = await booked(0, "2027-02-10", "2027-02-12");
    expect(await requestEarlyCheckinAsGuest(db, { reservationId: r.id, time: "09:00", now: at("2027-01-06") })).toEqual({ ok: false, error: "time_unavailable" });
    expect(await requestEarlyCheckinAsGuest(db, { reservationId: r.id, time: "12:00", now: at("2027-01-06") })).toEqual({ ok: true });
    expect(await requestEarlyCheckinAsGuest(db, { reservationId: r.id, time: "12:30", now: at("2027-01-06") })).toEqual({ ok: false, error: "already_requested" });
    expect((await guestEarlyCheckin(db, r.id, at("2027-01-06")))?.request).toMatchObject({ status: "requested", time: "12:00" });
    expect(await cancelEarlyCheckinAsGuest(db, { reservationId: r.id })).toEqual({ ok: true });
    expect(await requestEarlyCheckinAsGuest(db, { reservationId: r.id, time: "12:30", now: at("2027-01-06") })).toEqual({ ok: true });
  });
});

describe("date changes asked by the guest", () => {
  it("shows the estimate, records one request, and staff apply it at today's price", async () => {
    const r = await booked(0, "2027-02-10", "2027-02-12");
    expect(await previewGuestDateChange(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-02-13", now: at("2027-01-06") })).toMatchObject({ ok: true, sameVilla: true, total: 3 * RATE, difference: RATE });
    expect(await previewGuestDateChange(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-03-13", now: at("2027-01-06") })).toMatchObject({ ok: false, error: "max_stay", maxNights: 30 });
    expect(await requestDateChangeAsGuest(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-02-13", now: at("2027-01-06") })).toEqual({ ok: true });
    expect(await requestDateChangeAsGuest(db, { reservationId: r.id, checkIn: "2027-02-11", checkOut: "2027-02-14", now: at("2027-01-06") })).toEqual({ ok: false, error: "already_requested" });
    const [req] = await db.select().from(schema.dateChangeRequests);
    expect(req).toMatchObject({ status: "requested", quotedTotal: 3 * RATE, previousTotal: 2 * RATE });

    expect(await approveDateChange(db, { reservationId: r.id, unitId: r.unitId, actor: staff })).toEqual({ ok: true });
    const [after] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, r.id));
    expect(after).toMatchObject({ checkOut: "2027-02-13", totalAmount: 3 * RATE });
    expect((await db.select().from(schema.dateChangeRequests))[0].status).toBe("approved");
  });

  it("can move the guest to another villa when theirs is taken, or decline with a reason the guest is told", async () => {
    const r = await booked(0, "2027-02-10", "2027-02-12");
    await booked(0, "2027-02-12", "2027-02-14");
    expect(await previewGuestDateChange(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-02-13" })).toMatchObject({ ok: true, sameVilla: false, total: null });
    await requestDateChangeAsGuest(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-02-13" });
    expect(await approveDateChange(db, { reservationId: r.id, unitId: r.unitId, actor: staff })).toMatchObject({ ok: false, error: "dates_unavailable" });
    expect(await approveDateChange(db, { reservationId: r.id, unitId: unitIds[1], actor: staff })).toEqual({ ok: true });
    expect((await db.select().from(schema.reservations).where(eq(schema.reservations.id, r.id)))[0]).toMatchObject({ unitId: unitIds[1], checkOut: "2027-02-13" });

    const other = await booked(2, "2027-03-01", "2027-03-03");
    await requestDateChangeAsGuest(db, { reservationId: other.id, checkIn: "2027-03-01", checkOut: "2027-03-04" });
    expect(await cancelDateChangeAsGuest(db, { reservationId: other.id })).toEqual({ ok: true });
    await requestDateChangeAsGuest(db, { reservationId: other.id, checkIn: "2027-03-01", checkOut: "2027-03-04" });
    expect(await declineDateChange(db, { reservationId: other.id, reason: "", actor: staff })).toEqual({ ok: false, error: "reason_required" });
    expect(await declineDateChange(db, { reservationId: other.id, reason: "Fully booked for a wedding", actor: staff })).toEqual({ ok: true });
    const declined = (await db.select().from(schema.notificationOutbox)).filter((m) => m.kind === "date_change_declined");
    expect(declined.length).toBeGreaterThan(0);
    expect((declined[0].payload as { reason: string }).reason).toBe("Fully booked for a wedding");
  });
});

describe("cancelling a booking with add-ons", () => {
  it("refunds add-ons in full: the cancellation fee is on the stay only", async () => {
    const made = await createAddon(db, { propertyId, name: { id: "Chef", en: "Chef" }, description: null, category: "food_beverage", pricing: "per_person", price: 450_000, needsTime: true, leadHours: 24, sortOrder: 0, actor: staff });
    if (!made.ok) throw new Error("addon");
    // Paid in full (arrival within the balance period), cancelled under a week before: the stay is charged 100%.
    const r = await booked(0, "2027-01-15", "2027-01-17", { addons: [{ addonId: made.id, serviceDate: "2027-01-16", serviceTime: "19:00", persons: 2 }] });
    expect(r).toMatchObject({ totalAmount: 2 * RATE + 900_000, amountPaid: 2 * RATE + 900_000 });
    expect(await cancelReservation(db, { reservationId: r.id, actor: { type: "guest" }, now: at("2027-01-12") })).toEqual({ ok: true, refund: 900_000, fee: 2 * RATE });
    const [after] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, r.id));
    expect(after).toMatchObject({ status: "cancelled", totalAmount: 2 * RATE, extrasAmount: 0, refundAmount: 900_000 });
    expect((await db.select().from(schema.folioCharges)).every((c) => c.status === "void")).toBe(true);
  });
});
