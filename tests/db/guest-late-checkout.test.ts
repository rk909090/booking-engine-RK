import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { createHold, createPendingPayment, recordPaymentPaid } from "@/domain/booking";
import {
  cancelLateCheckoutAsGuest,
  decideLateCheckout,
  guestLateCheckout,
  guestLateCheckoutTimes,
  lateCheckoutStatus,
  requestLateCheckoutAsGuest,
} from "@/domain/late-checkout";
import { createTestDb, type TestDb } from "./test-db";

// 03:00 UTC = 11:00 in Bali.
const at = (date: string, utcTime = "03:00") => new Date(`${date}T${utcTime}:00Z`);
const staff = { type: "staff" as const, id: "fo-1" };
const now = at("2027-01-05");

let db: TestDb;
let close: () => Promise<void>;
let typeId: string;
let unitIds: string[];

beforeAll(async () => {
  const test = await createTestDb();
  db = test.db;
  close = () => test.client.close();
  await seedSampleData(db);
  const [type] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.slug, "river-pavilion"));
  typeId = type.id;
  unitIds = (await db.select().from(schema.units).where(eq(schema.units.unitTypeId, typeId)).orderBy(schema.units.code)).map((u) => u.id);
});

afterAll(async () => close());

beforeEach(async () => {
  for (const table of [schema.lateCheckoutRequests, schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests]) {
    await db.delete(table);
  }
});

async function booking(ci: string, co: string, unit: number, eta: string | null = null) {
  const h = await createHold(db, {
    unitTypeId: typeId, checkIn: ci, checkOut: co, adults: 2, children: 0,
    guest: { fullName: `Guest ${ci}`, email: "guest@example.com" }, locale: "en", source: "direct",
    estimatedArrival: eta, now: at("2027-01-01"), candidateUnitIds: [unitIds[unit]],
  });
  if (!h.ok) throw new Error(JSON.stringify(h.error));
  const ref = `ref-${h.reservation.code}`;
  await createPendingPayment(db, { reservationId: h.reservation.id, provider: "simulated", providerRef: ref, purpose: "deposit", amount: h.reservation.depositAmount, checkoutUrl: null, expiresAt: null });
  await recordPaymentPaid(db, { provider: "simulated", providerRef: ref, amount: h.reservation.depositAmount, paidAt: at("2027-01-01") });
  return h.reservation;
}

describe("times a guest can choose", () => {
  it("runs every 30 minutes after check-out, up to the limit and never past 18:00, and only later than now on the departure day", () => {
    expect(guestLateCheckoutTimes({ standardCheckOut: "11:00", latestAllowed: "13:00", nowTime: null })).toEqual(["11:30", "12:00", "12:30", "13:00"]);
    expect(guestLateCheckoutTimes({ standardCheckOut: "11:00", latestAllowed: null, nowTime: null })).toHaveLength(14);
    expect(guestLateCheckoutTimes({ standardCheckOut: "11:00", latestAllowed: null, nowTime: null }).at(-1)).toBe("18:00");
    expect(guestLateCheckoutTimes({ standardCheckOut: "11:00", latestAllowed: "10:00", nowTime: null })).toEqual([]);
    expect(guestLateCheckoutTimes({ standardCheckOut: "11:00", latestAllowed: "13:00", nowTime: "12:10" })).toEqual(["12:30", "13:00"]);
  });
});

describe("late check-out from the guest's booking page", () => {
  it("offers only the times still possible before the next guest, and sends the request to staff", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    await booking("2027-02-12", "2027-02-14", 0); // arrives at 14:00, turnover 120 min → leave by 12:00
    const view = await guestLateCheckout(db, r.id, now);
    expect(view).toEqual({ standardCheckOut: "11:00", request: null, times: ["11:30", "12:00"] });

    expect(await requestLateCheckoutAsGuest(db, { reservationId: r.id, time: "13:00", now })).toEqual({ ok: false, error: "time_unavailable" });
    expect(await requestLateCheckoutAsGuest(db, { reservationId: r.id, time: "12:00", note: "Late flight", now })).toEqual({ ok: true });
    expect(await requestLateCheckoutAsGuest(db, { reservationId: r.id, time: "11:30", now })).toEqual({ ok: false, error: "already_requested" });

    const staffView = await lateCheckoutStatus(db, r.id, now);
    expect(staffView?.request).toMatchObject({ status: "requested", requestedTime: "12:00:00", requestedBy: "guest", note: "Late flight" });
    const [event] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "late_checkout.requested"));
    expect(event).toMatchObject({ actorType: "guest", actorId: null });
    expect((await guestLateCheckout(db, r.id, now))?.request).toEqual({ status: "requested", time: "12:00", fee: 0 });
  });

  it("goes up to 18:00 with nobody arriving, and shows the decision and fee to the guest", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    expect((await guestLateCheckout(db, r.id, now))?.times.at(-1)).toBe("18:00");
    await requestLateCheckoutAsGuest(db, { reservationId: r.id, time: "16:00", now });
    await decideLateCheckout(db, { reservationId: r.id, approve: true, fee: 500_000, actor: staff, now });
    expect((await guestLateCheckout(db, r.id, now))?.request).toEqual({ status: "approved", time: "16:00", fee: 500_000 });
    // Decided: the guest can no longer withdraw it themselves.
    expect(await cancelLateCheckoutAsGuest(db, { reservationId: r.id, now })).toEqual({ ok: false, error: "not_pending" });
  });

  it("lets the guest withdraw a waiting request and ask again after a decline", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    await requestLateCheckoutAsGuest(db, { reservationId: r.id, time: "14:00", now });
    expect(await cancelLateCheckoutAsGuest(db, { reservationId: r.id, now })).toEqual({ ok: true });
    expect((await guestLateCheckout(db, r.id, now))?.request?.status).toBe("cancelled");

    const later = at("2027-01-06");
    await requestLateCheckoutAsGuest(db, { reservationId: r.id, time: "15:00", now: later });
    await decideLateCheckout(db, { reservationId: r.id, approve: false, actor: staff, now: later });
    expect((await guestLateCheckout(db, r.id, later))?.request).toMatchObject({ status: "declined", time: "15:00" });
    expect(await requestLateCheckoutAsGuest(db, { reservationId: r.id, time: "13:00", now: at("2027-01-07") })).toEqual({ ok: true });
  });

  it("on the departure day offers only later times, and nothing once the stay is over or not confirmed", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    // 04:10 UTC = 12:10 in Bali on the departure day.
    expect((await guestLateCheckout(db, r.id, at("2027-02-12", "04:10")))?.times[0]).toBe("12:30");
    expect(await guestLateCheckout(db, r.id, at("2027-02-13"))).toBeNull();
    expect(await requestLateCheckoutAsGuest(db, { reservationId: r.id, time: "14:00", now: at("2027-02-13") })).toEqual({ ok: false, error: "not_allowed" });

    const h = await createHold(db, {
      unitTypeId: typeId, checkIn: "2027-03-10", checkOut: "2027-03-12", adults: 1, children: 0,
      guest: { fullName: "H", email: "h@example.com" }, locale: "en", source: "website", now, candidateUnitIds: [unitIds[1]],
    });
    if (!h.ok) throw new Error();
    expect(await guestLateCheckout(db, h.reservation.id, now)).toBeNull();
  });
});
