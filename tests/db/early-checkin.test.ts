import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { createHold, createPendingPayment, recordPaymentPaid } from "@/domain/booking";
import { assessEarlyCheckin, cancelEarlyCheckin, decideEarlyCheckin, earlyCheckinStatus, requestEarlyCheckin } from "@/domain/early-checkin";
import { decideLateCheckout, lateCheckoutStatus, requestLateCheckout } from "@/domain/late-checkout";
import { applyStayChange, previewStayChange } from "@/domain/modify";
import { createTestDb, type TestDb } from "./test-db";

const at = (date: string) => new Date(`${date}T03:00:00Z`);
const RATE = 6_500_000;
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
  for (const table of [schema.earlyCheckinRequests, schema.lateCheckoutRequests, schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests]) {
    await db.delete(table);
  }
});

async function booking(ci: string, co: string, unit: number, opts: { full?: boolean; eta?: string } = {}) {
  const h = await createHold(db, {
    unitTypeId: typeId,
    checkIn: ci,
    checkOut: co,
    adults: 2,
    children: 0,
    guest: { fullName: `Guest ${ci}`, email: "guest@example.com" },
    locale: "en",
    source: "direct",
    estimatedArrival: opts.eta ?? null,
    now: at("2027-01-01"),
    candidateUnitIds: [unitIds[unit]],
  });
  if (!h.ok) throw new Error(JSON.stringify(h.error));
  const amount = opts.full ? h.reservation.totalAmount : h.reservation.depositAmount;
  const ref = `ref-${h.reservation.code}`;
  await createPendingPayment(db, { reservationId: h.reservation.id, provider: "simulated", providerRef: ref, purpose: "deposit", amount, checkoutUrl: null, expiresAt: null });
  await recordPaymentPaid(db, { provider: "simulated", providerRef: ref, amount, paidAt: at("2027-01-01") });
  return h.reservation;
}

async function reload(id: string) {
  const [r] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, id));
  return r;
}

describe("earliest possible arrival", () => {
  it("is the previous departure plus the turnover time", () => {
    expect(assessEarlyCheckin({ requestedTime: "13:00", departureTime: "11:00", turnoverMinutes: 120 })).toEqual({ earliestAllowed: "13:00", conflict: false });
    expect(assessEarlyCheckin({ requestedTime: "12:30", departureTime: "11:00", turnoverMinutes: 120 })).toEqual({ earliestAllowed: "13:00", conflict: true });
    expect(assessEarlyCheckin({ requestedTime: "08:00", departureTime: null, turnoverMinutes: 120 })).toEqual({ earliestAllowed: null, conflict: false });
  });
});

describe("early check-in requests", () => {
  it("approves when nobody leaves the villa that day, adding the fee", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    expect(await requestEarlyCheckin(db, { reservationId: r.id, time: "14:00", actor: staff, now })).toEqual({ ok: false, error: "invalid_time" });
    expect(await requestEarlyCheckin(db, { reservationId: r.id, time: "09:00", note: "Morning flight", actor: staff, now })).toEqual({ ok: true });
    expect(await requestEarlyCheckin(db, { reservationId: r.id, time: "10:00", actor: staff, now })).toEqual({ ok: false, error: "already_requested" });
    expect((await earlyCheckinStatus(db, r.id, now))?.check).toMatchObject({ standardCheckIn: "14:00", previousDeparture: null, conflict: false });
    expect(await decideEarlyCheckin(db, { reservationId: r.id, approve: true, fee: 400_000, actor: staff, now })).toEqual({ ok: true });
    expect(await reload(r.id)).toMatchObject({ extrasAmount: 400_000, totalAmount: 2 * RATE + 400_000 });
  });

  it("refuses an arrival before the previous guest has left and the villa is ready", async () => {
    const prev = await booking("2027-02-08", "2027-02-10", 0);
    const r = await booking("2027-02-10", "2027-02-12", 0);
    await requestEarlyCheckin(db, { reservationId: r.id, time: "12:00", actor: staff, now });
    expect(await decideEarlyCheckin(db, { reservationId: r.id, approve: true, actor: staff, now })).toEqual({
      ok: false,
      error: "conflict",
      codes: [prev.code],
      earliestAllowed: "13:00",
    });
    await decideEarlyCheckin(db, { reservationId: r.id, approve: false, actor: staff, now });
    await requestEarlyCheckin(db, { reservationId: r.id, time: "13:00", actor: staff, now });
    expect(await decideEarlyCheckin(db, { reservationId: r.id, approve: true, actor: staff, now })).toEqual({ ok: true });
  });

  it("counts an approved late check-out of the previous guest", async () => {
    const prev = await booking("2027-02-08", "2027-02-10", 0);
    await requestLateCheckout(db, { reservationId: prev.id, time: "12:00", actor: staff, now });
    await decideLateCheckout(db, { reservationId: prev.id, approve: true, actor: staff, now });
    const r = await booking("2027-02-10", "2027-02-12", 0);
    await requestEarlyCheckin(db, { reservationId: r.id, time: "13:30", actor: staff, now });
    const status = await earlyCheckinStatus(db, r.id, now);
    expect(status?.check).toMatchObject({ earliestAllowed: "14:00", conflict: true, previousDeparture: { code: prev.code, departureTime: "12:00", source: "late" } });
  });

  it("only applies to confirmed bookings that have not arrived", async () => {
    const h = await createHold(db, {
      unitTypeId: typeId, checkIn: "2027-02-10", checkOut: "2027-02-12", adults: 1, children: 0,
      guest: { fullName: "H", email: "h@example.com" }, locale: "en", source: "website", now, candidateUnitIds: [unitIds[0]],
    });
    if (!h.ok) throw new Error();
    expect(await requestEarlyCheckin(db, { reservationId: h.reservation.id, time: "10:00", actor: staff, now })).toEqual({ ok: false, error: "not_allowed" });
    const r = await booking("2027-02-10", "2027-02-12", 1);
    expect(await requestEarlyCheckin(db, { reservationId: r.id, time: "10:00", actor: staff, now: at("2027-02-11") })).toEqual({ ok: false, error: "after_arrival" });
  });

  it("is withdrawn with its fee when the arrival date changes, and a paid fee becomes a refund when cancelled", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0, { full: true });
    await requestEarlyCheckin(db, { reservationId: r.id, time: "10:00", actor: staff, now });
    await decideEarlyCheckin(db, { reservationId: r.id, approve: true, fee: 300_000, actor: staff, now });
    const preview = await previewStayChange(db, { reservationId: r.id, checkIn: "2027-02-11", checkOut: "2027-02-12", unitId: unitIds[0], now });
    expect(preview.ok && preview.plan).toMatchObject({ earlyCheckinCancelled: true, extras: 0, total: RATE });

    // Paid fee, then cancelled: owed back.
    const ref = "fee";
    await createPendingPayment(db, { reservationId: r.id, provider: "manual", providerRef: ref, purpose: "balance", amount: 300_000, checkoutUrl: null, expiresAt: null });
    await recordPaymentPaid(db, { provider: "manual", providerRef: ref, amount: 300_000, paidAt: now });
    expect(await cancelEarlyCheckin(db, { reservationId: r.id, actor: staff, now })).toEqual({ ok: true });
    expect(await reload(r.id)).toMatchObject({ extrasAmount: 0, totalAmount: 2 * RATE, refundAmount: 300_000 });

    await requestEarlyCheckin(db, { reservationId: r.id, time: "10:00", actor: staff, now });
    if (!preview.ok) throw new Error();
    const again = await previewStayChange(db, { reservationId: r.id, checkIn: "2027-02-11", checkOut: "2027-02-12", unitId: unitIds[0], now });
    if (!again.ok) throw new Error();
    await applyStayChange(db, { reservationId: r.id, checkIn: "2027-02-11", checkOut: "2027-02-12", unitId: unitIds[0], expectedTotal: again.plan.total, actor: staff, now });
    const [request] = await db.select().from(schema.earlyCheckinRequests).where(eq(schema.earlyCheckinRequests.status, "cancelled")).orderBy(schema.earlyCheckinRequests.createdAt);
    expect(request).toBeTruthy();
    expect((await earlyCheckinStatus(db, r.id, now))?.request).toBeNull();
  });
});

describe("late check-out limit for the next guest", () => {
  it("uses their approved early check-in, otherwise the later of their ETA and the check-in time", async () => {
    const r = await booking("2027-02-08", "2027-02-10", 0);
    const next = await booking("2027-02-10", "2027-02-12", 0, { eta: "10:00" });
    // An ETA before the check-in time does not move the villa-ready time.
    expect((await lateCheckoutStatus(db, r.id, now))?.check).toMatchObject({ latestAllowed: "12:00", nextArrival: { arrivalTime: "14:00", source: "standard" } });
    // An approved early check-in does.
    await requestEarlyCheckin(db, { reservationId: next.id, time: "13:00", actor: staff, now });
    expect(await decideEarlyCheckin(db, { reservationId: next.id, approve: true, actor: staff, now })).toEqual({ ok: true });
    expect((await lateCheckoutStatus(db, r.id, now))?.check).toMatchObject({ latestAllowed: "11:00", nextArrival: { arrivalTime: "13:00", source: "early" } });
    await requestLateCheckout(db, { reservationId: r.id, time: "11:30", actor: staff, now });
    expect((await decideLateCheckout(db, { reservationId: r.id, approve: true, actor: staff, now })).ok).toBe(false);
  });

  it("allows a later departure when the next guest arrives in the evening", async () => {
    const r = await booking("2027-02-08", "2027-02-10", 0);
    await booking("2027-02-10", "2027-02-12", 0, { eta: "18:00" });
    expect((await lateCheckoutStatus(db, r.id, now))?.check).toMatchObject({ latestAllowed: "16:00", nextArrival: { arrivalTime: "18:00", source: "eta" } });
  });
});
