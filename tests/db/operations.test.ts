import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { cancelReservation, createHold, createPendingPayment, recordPaymentPaid } from "@/domain/booking";
import { checkIn, checkOut, markNoShow, recordRefundPayout, stayActions, type StayFacts } from "@/domain/operations";
import { createTestDb, type TestDb } from "./test-db";

// Bali dates for a fixed instant: 03:00 UTC = 11:00 WITA.
const at = (date: string) => new Date(`${date}T03:00:00Z`);
const staff = { type: "staff" as const, id: "staff-1" };

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
  await db.delete(schema.notificationOutbox);
  await db.delete(schema.payments);
  await db.delete(schema.auditEvents);
  await db.delete(schema.reservations);
  await db.delete(schema.guests);
});

/** A confirmed, deposit-paid booking created on `bookedOn`. */
async function confirmed(checkInDate: string, checkOutDate: string, opts: { unit?: number; bookedOn?: string; payFull?: boolean } = {}) {
  const now = at(opts.bookedOn ?? "2027-01-01");
  const held = await createHold(db, {
    unitTypeId: typeId,
    checkIn: checkInDate,
    checkOut: checkOutDate,
    adults: 2,
    children: 0,
    guest: { fullName: "Guest", email: "g@example.com" },
    locale: "en",
    source: "direct",
    now,
    candidateUnitIds: [unitIds[opts.unit ?? 0]],
  });
  if (!held.ok) throw new Error(JSON.stringify(held.error));
  const r = held.reservation;
  const amount = opts.payFull ? r.totalAmount : r.depositAmount;
  const ref = `p-${r.code}`;
  await createPendingPayment(db, { reservationId: r.id, provider: "simulated", providerRef: ref, purpose: "deposit", amount, checkoutUrl: null, expiresAt: null });
  await recordPaymentPaid(db, { provider: "simulated", providerRef: ref, amount, paidAt: now });
  return r;
}

async function status(id: string) {
  const [r] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, id));
  return r;
}

describe("stayActions", () => {
  const base: StayFacts = {
    status: "confirmed",
    checkIn: "2027-02-10",
    checkOut: "2027-02-13",
    today: "2027-02-10",
    unitOccupiedByOther: false,
    refundOutstanding: 0,
  };

  it("allows check-in only during the stay and when the unit is free", () => {
    expect(stayActions(base).checkIn).toEqual({ allowed: true });
    expect(stayActions({ ...base, today: "2027-02-09" }).checkIn).toEqual({ allowed: false, reason: "before_arrival" });
    expect(stayActions({ ...base, today: "2027-02-13" }).checkIn).toEqual({ allowed: false, reason: "after_departure" });
    expect(stayActions({ ...base, unitOccupiedByOther: true }).checkIn).toEqual({ allowed: false, reason: "unit_occupied" });
    expect(stayActions({ ...base, status: "hold" }).checkIn).toEqual({ allowed: false, reason: "not_confirmed" });
  });

  it("allows a no-show only after the arrival day, and then not a cancellation", () => {
    expect(stayActions(base).noShow).toEqual({ allowed: false, reason: "arrival_not_passed" });
    expect(stayActions({ ...base, today: "2027-02-11" }).noShow).toEqual({ allowed: true });
    expect(stayActions({ ...base, today: "2027-02-11" }).cancel).toEqual({ allowed: false, reason: "use_no_show" });
    expect(stayActions({ ...base, today: "2027-02-10" }).cancel).toEqual({ allowed: true });
  });

  it("explains that an in-house guest has already arrived", () => {
    const a = stayActions({ ...base, status: "in_house", today: "2027-02-11" });
    expect([a.checkIn, a.noShow, a.cancel]).toEqual(Array(3).fill({ allowed: false, reason: "in_house" }));
    expect(a.checkOut).toEqual({ allowed: true });
  });

  it("treats finished bookings as final", () => {
    for (const status of ["checked_out", "cancelled", "no_show", "expired"] as const) {
      const a = stayActions({ ...base, status });
      expect([a.checkIn, a.checkOut, a.noShow, a.cancel]).toEqual(Array(4).fill({ allowed: false, reason: "final_status" }));
    }
  });
});

describe("front desk operations", () => {
  it("checks in on the arrival day and out on the departure day", async () => {
    const r = await confirmed("2027-02-10", "2027-02-13", { payFull: true });
    expect(await checkIn(db, { reservationId: r.id, actor: staff, now: at("2027-02-09") })).toEqual({ ok: false, error: "before_arrival" });
    expect(await checkIn(db, { reservationId: r.id, actor: staff, now: at("2027-02-10") })).toEqual({ ok: true });
    expect((await status(r.id)).status).toBe("in_house");
    expect(await checkOut(db, { reservationId: r.id, actor: staff, now: at("2027-02-13") })).toEqual({ ok: true });
    const after = await status(r.id);
    expect([after.status, after.checkOut]).toEqual(["checked_out", "2027-02-13"]);
    const log = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId, r.id));
    expect(log.map((e) => e.action)).toEqual(expect.arrayContaining(["reservation.checked_in", "reservation.checked_out"]));
  });

  it("blocks check-in while the previous guest is still in the villa", async () => {
    const first = await confirmed("2027-02-07", "2027-02-10", { payFull: true });
    const second = await confirmed("2027-02-10", "2027-02-12", { payFull: true });
    await checkIn(db, { reservationId: first.id, actor: staff, now: at("2027-02-07") });
    expect(await checkIn(db, { reservationId: second.id, actor: staff, now: at("2027-02-10") })).toEqual({
      ok: false,
      error: "unit_occupied",
    });
    await checkOut(db, { reservationId: first.id, actor: staff, now: at("2027-02-10") });
    expect(await checkIn(db, { reservationId: second.id, actor: staff, now: at("2027-02-10") })).toEqual({ ok: true });
  });

  it("requires acknowledging an unpaid balance at check-out", async () => {
    const r = await confirmed("2027-02-10", "2027-02-13");
    await checkIn(db, { reservationId: r.id, actor: staff, now: at("2027-02-10") });
    expect(await checkOut(db, { reservationId: r.id, actor: staff, now: at("2027-02-13") })).toEqual({
      ok: false,
      error: "balance_outstanding",
    });
    expect(await checkOut(db, { reservationId: r.id, actor: staff, acknowledgeBalance: true, now: at("2027-02-13") })).toEqual({ ok: true });
  });

  it("shortens the stay on early departure so the remaining nights can be sold", async () => {
    const r = await confirmed("2027-02-10", "2027-02-15", { payFull: true });
    await checkIn(db, { reservationId: r.id, actor: staff, now: at("2027-02-10") });
    await checkOut(db, { reservationId: r.id, actor: staff, now: at("2027-02-12") });
    expect((await status(r.id)).checkOut).toBe("2027-02-12");
    const next = await createHold(db, {
      unitTypeId: typeId,
      checkIn: "2027-02-12",
      checkOut: "2027-02-15",
      adults: 2,
      children: 0,
      guest: { fullName: "Next", email: "n@example.com" },
      locale: "en",
      source: "direct",
      now: at("2027-02-12"),
      candidateUnitIds: [unitIds[0]],
    });
    expect(next.ok).toBe(true);
  });

  it("records a no-show the day after arrival and releases the nights", async () => {
    const r = await confirmed("2027-02-10", "2027-02-13");
    expect(await markNoShow(db, { reservationId: r.id, actor: staff, now: at("2027-02-10") })).toEqual({
      ok: false,
      error: "arrival_not_passed",
    });
    expect(await markNoShow(db, { reservationId: r.id, actor: staff, now: at("2027-02-11") })).toEqual({ ok: true });
    expect((await status(r.id)).status).toBe("no_show");
  });
});

describe("recordRefundPayout", () => {
  it("pays out a refund in parts and never more than is owed", async () => {
    const r = await confirmed("2027-03-10", "2027-03-13");
    const cancelled = await cancelReservation(db, { reservationId: r.id, actor: staff, now: at("2027-01-02") });
    expect(cancelled).toEqual({ ok: true, refund: r.depositAmount, fee: 0 });

    const half = Math.floor(r.depositAmount / 2);
    expect(await recordRefundPayout(db, { reservationId: r.id, amount: r.depositAmount + 1, reference: "x", actor: staff })).toEqual({
      ok: false,
      error: "invalid_amount",
    });
    expect(await recordRefundPayout(db, { reservationId: r.id, amount: half, reference: "BCA 001", actor: staff })).toEqual({ ok: true });
    expect(
      await recordRefundPayout(db, { reservationId: r.id, amount: r.depositAmount - half, reference: "BCA 002", actor: staff }),
    ).toEqual({ ok: true });
    expect(await recordRefundPayout(db, { reservationId: r.id, amount: 1, reference: "x", actor: staff })).toEqual({
      ok: false,
      error: "no_refund_due",
    });
    const refunds = await db.select().from(schema.payments).where(eq(schema.payments.purpose, "refund"));
    expect(refunds.map((p) => p.provider)).toEqual(["manual", "manual"]);
  });
});
