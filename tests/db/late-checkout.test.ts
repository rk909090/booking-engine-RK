import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { createHold, createPendingPayment, recordPaymentPaid } from "@/domain/booking";
import { assessLateCheckout, cancelLateCheckout, decideLateCheckout, lateCheckoutStatus, requestLateCheckout } from "@/domain/late-checkout";
import { applyStayChange, previewStayChange } from "@/domain/modify";
import { balanceDue } from "@/domain/pricing";
import { createTestDb, type TestDb } from "./test-db";

// 03:00 UTC = 11:00 in Bali.
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
  for (const table of [schema.lateCheckoutRequests, schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests]) {
    await db.delete(table);
  }
});

/** A confirmed booking; `full` pays the whole stay. */
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
    candidateUnitIds: unit >= 0 ? [unitIds[unit]] : undefined,
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

describe("latest possible departure", () => {
  it("is the next arrival minus the turnover time", () => {
    expect(assessLateCheckout({ requestedTime: "13:00", arrivalTime: "15:00", turnoverMinutes: 120 })).toEqual({ latestAllowed: "13:00", conflict: false });
    expect(assessLateCheckout({ requestedTime: "13:30", arrivalTime: "15:00", turnoverMinutes: 120 })).toEqual({ latestAllowed: "13:00", conflict: true });
    expect(assessLateCheckout({ requestedTime: "18:00", arrivalTime: null, turnoverMinutes: 120 })).toEqual({ latestAllowed: null, conflict: false });
  });
});

describe("late check-out requests", () => {
  it("approves without a next arrival and adds the fee to the bill", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    expect(await requestLateCheckout(db, { reservationId: r.id, time: "11:00", actor: staff, now })).toEqual({ ok: false, error: "invalid_time" });
    expect(await requestLateCheckout(db, { reservationId: r.id, time: "16:00", note: "Late flight", actor: staff, now })).toEqual({ ok: true });
    expect(await requestLateCheckout(db, { reservationId: r.id, time: "15:00", actor: staff, now })).toEqual({ ok: false, error: "already_requested" });

    const status = await lateCheckoutStatus(db, r.id, now);
    expect(status?.check).toMatchObject({ standardCheckOut: "11:00", nextArrival: null, conflict: false });
    expect(await decideLateCheckout(db, { reservationId: r.id, approve: true, fee: 750_000, actor: staff, now })).toEqual({ ok: true });
    const after = await reload(r.id);
    expect(after).toMatchObject({ extrasAmount: 750_000, totalAmount: 2 * RATE + 750_000 });
    expect(balanceDue(after)).toBe(2 * RATE + 750_000 - r.depositAmount);
    expect(await decideLateCheckout(db, { reservationId: r.id, approve: false, actor: staff, now })).toEqual({ ok: false, error: "not_pending" });
    const actions = (await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId, r.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["late_checkout.requested", "late_checkout.approved"]));
  });

  it("refuses approval past the next arrival's ETA minus turnover, and names that booking", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    const next = await booking("2027-02-12", "2027-02-14", 0, { eta: "14:00" });
    await requestLateCheckout(db, { reservationId: r.id, time: "13:00", actor: staff, now });
    expect(await decideLateCheckout(db, { reservationId: r.id, approve: true, actor: staff, now })).toEqual({
      ok: false,
      error: "conflict",
      codes: [next.code],
      latestAllowed: "12:00",
    });
    // Declining is always possible.
    expect(await decideLateCheckout(db, { reservationId: r.id, approve: false, note: "Next guest at 14:00", actor: staff, now })).toEqual({ ok: true });
    // 12:00 fits exactly.
    await requestLateCheckout(db, { reservationId: r.id, time: "12:00", actor: staff, now });
    expect(await decideLateCheckout(db, { reservationId: r.id, approve: true, actor: staff, now })).toEqual({ ok: true });
  });

  it("uses the property's check-in time when the next guest gave no ETA, and is solved by moving that guest", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    const next = await booking("2027-02-12", "2027-02-14", 0);
    await requestLateCheckout(db, { reservationId: r.id, time: "15:00", actor: staff, now });
    const status = await lateCheckoutStatus(db, r.id, now);
    expect(status?.check).toMatchObject({ latestAllowed: "12:00", conflict: true, nextArrival: { code: next.code, arrivalTime: "14:00", source: "standard" } });

    const preview = await previewStayChange(db, { reservationId: next.id, checkIn: next.checkIn, checkOut: next.checkOut, unitId: unitIds[1], now });
    if (!preview.ok) throw new Error();
    await applyStayChange(db, { reservationId: next.id, checkIn: next.checkIn, checkOut: next.checkOut, unitId: unitIds[1], expectedTotal: preview.plan.total, actor: staff, now });
    expect(await decideLateCheckout(db, { reservationId: r.id, approve: true, actor: staff, now })).toEqual({ ok: true });
  });

  it("takes a cancelled fee off the bill, owing it back when it was already paid", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0, { full: true });
    await requestLateCheckout(db, { reservationId: r.id, time: "16:00", actor: staff, now });
    await decideLateCheckout(db, { reservationId: r.id, approve: true, fee: 500_000, actor: staff, now });
    const ref = "fee-paid";
    await createPendingPayment(db, { reservationId: r.id, provider: "manual", providerRef: ref, purpose: "balance", amount: 500_000, checkoutUrl: null, expiresAt: null });
    await recordPaymentPaid(db, { provider: "manual", providerRef: ref, amount: 500_000, paidAt: now });
    expect(await cancelLateCheckout(db, { reservationId: r.id, actor: staff, now })).toEqual({ ok: true });
    const after = await reload(r.id);
    expect(after).toMatchObject({ extrasAmount: 0, totalAmount: 2 * RATE, refundAmount: 500_000 });
    expect(balanceDue(after)).toBe(0);
  });

  it("is withdrawn, fee included, when the departure date changes", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    await requestLateCheckout(db, { reservationId: r.id, time: "16:00", actor: staff, now });
    await decideLateCheckout(db, { reservationId: r.id, approve: true, fee: 500_000, actor: staff, now });
    const preview = await previewStayChange(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-02-13", unitId: unitIds[0], now });
    expect(preview.ok && preview.plan).toMatchObject({ lateCheckoutCancelled: true, extras: 0, total: 3 * RATE, difference: RATE - 500_000 });
    if (!preview.ok) throw new Error();
    await applyStayChange(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-02-13", unitId: unitIds[0], expectedTotal: preview.plan.total, actor: staff, now });
    expect(await reload(r.id)).toMatchObject({ totalAmount: 3 * RATE, extrasAmount: 0 });
    const [request] = await db.select().from(schema.lateCheckoutRequests);
    expect(request.status).toBe("cancelled");

    // Changing only the villa keeps an approved late check-out and its fee.
    await requestLateCheckout(db, { reservationId: r.id, time: "16:00", actor: staff, now });
    await decideLateCheckout(db, { reservationId: r.id, approve: true, fee: 500_000, actor: staff, now });
    const move = await previewStayChange(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-02-13", unitId: unitIds[1], now });
    expect(move.ok && move.plan).toMatchObject({ lateCheckoutCancelled: false, total: 3 * RATE + 500_000, difference: 0 });
  });

  it("only applies to confirmed or in-house bookings", async () => {
    const h = await createHold(db, {
      unitTypeId: typeId, checkIn: "2027-02-10", checkOut: "2027-02-12", adults: 1, children: 0,
      guest: { fullName: "H", email: "h@example.com" }, locale: "en", source: "website", now, candidateUnitIds: [unitIds[0]],
    });
    if (!h.ok) throw new Error();
    expect(await requestLateCheckout(db, { reservationId: h.reservation.id, time: "14:00", actor: staff, now })).toEqual({ ok: false, error: "not_allowed" });
  });
});

describe("new bookings", () => {
  it("avoid a villa whose guest leaves late on the arrival day", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    await requestLateCheckout(db, { reservationId: r.id, time: "16:00", actor: staff, now });
    await decideLateCheckout(db, { reservationId: r.id, approve: true, actor: staff, now });
    const next = await booking("2027-02-12", "2027-02-14", -1);
    expect(next.unitId).toBe(unitIds[1]);
  });
});
