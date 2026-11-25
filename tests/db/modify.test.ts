import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { cancelReservation, createHold, createPendingPayment, recordPaymentPaid } from "@/domain/booking";
import { applyStayChange, previewStayChange } from "@/domain/modify";
import { checkIn, recordRefundPayout } from "@/domain/operations";
import { balanceDue } from "@/domain/pricing";
import { createTestDb, type TestDb } from "./test-db";

// 03:00 UTC = 11:00 in Bali.
const at = (date: string) => new Date(`${date}T03:00:00Z`);
const staff = { type: "staff" as const, id: "fo-1" };
const RATE = 6_500_000; // River Pavilion base rate in the sample data

let db: TestDb;
let close: () => Promise<void>;
let typeId: string;
let otherTypeUnitId: string;
let unitIds: string[];

beforeAll(async () => {
  const test = await createTestDb();
  db = test.db;
  close = () => test.client.close();
  await seedSampleData(db);
  const [type] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.slug, "river-pavilion"));
  typeId = type.id;
  unitIds = (await db.select().from(schema.units).where(eq(schema.units.unitTypeId, typeId)).orderBy(schema.units.code)).map((u) => u.id);
  const [canopy] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.slug, "canopy-villa"));
  [{ id: otherTypeUnitId }] = await db.select({ id: schema.units.id }).from(schema.units).where(eq(schema.units.unitTypeId, canopy.id));
});

afterAll(async () => close());

beforeEach(async () => {
  for (const table of [schema.housekeepingEvents, schema.unitStatus, schema.unitBlocks, schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests]) {
    await db.delete(table);
  }
  await db.update(schema.unitTypes).set({ baseRate: RATE, minStayNights: 1 }).where(eq(schema.unitTypes.id, typeId));
});

/** A paid booking: the deposit, or the full total when `full` is set. */
async function booking(ci: string, co: string, unit: number, opts: { full?: boolean; now?: Date } = {}) {
  const now = opts.now ?? at("2027-01-01");
  const h = await createHold(db, {
    unitTypeId: typeId,
    checkIn: ci,
    checkOut: co,
    adults: 2,
    children: 0,
    guest: { fullName: "Guest", email: "guest@example.com" },
    locale: "en",
    source: "direct",
    now,
    candidateUnitIds: [unitIds[unit]],
  });
  if (!h.ok) throw new Error(JSON.stringify(h.error));
  const amount = opts.full ? h.reservation.totalAmount : h.reservation.depositAmount;
  const ref = `ref-${h.reservation.code}`;
  await createPendingPayment(db, { reservationId: h.reservation.id, provider: "simulated", providerRef: ref, purpose: opts.full ? "full" : "deposit", amount, checkoutUrl: null, expiresAt: null });
  await recordPaymentPaid(db, { provider: "simulated", providerRef: ref, amount, paidAt: now });
  return h.reservation;
}

async function reload(id: string) {
  const [r] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, id));
  return r;
}

async function change(id: string, checkInDate: string, checkOutDate: string, unitId: string, now: Date) {
  const preview = await previewStayChange(db, { reservationId: id, checkIn: checkInDate, checkOut: checkOutDate, unitId, now });
  if (!preview.ok) return preview;
  return applyStayChange(db, { reservationId: id, checkIn: checkInDate, checkOut: checkOutDate, unitId, expectedTotal: preview.plan.total, actor: staff, now });
}

describe("changing dates", () => {
  it("extends a stay: added nights are priced, the balance grows, and it is logged", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    const now = at("2027-01-05");
    const preview = await previewStayChange(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-02-14", unitId: unitIds[0], now });
    expect(preview.ok && preview.plan).toMatchObject({
      previousTotal: 2 * RATE,
      difference: 2 * RATE,
      balanceAfter: 4 * RATE - r.depositAmount,
      refundOutstandingAfter: 0,
      balanceDueDate: "2027-01-27",
      moved: false,
    });
    // Preview changes nothing.
    expect((await reload(r.id)).checkOut).toBe("2027-02-12");

    const applied = await change(r.id, "2027-02-10", "2027-02-14", unitIds[0], now);
    expect(applied.ok).toBe(true);
    const after = await reload(r.id);
    expect(after).toMatchObject({ checkOut: "2027-02-14", totalAmount: 4 * RATE, subtotalAmount: 4 * RATE, refundAmount: null });
    expect(after.priceSnapshot?.nights.map((n) => n.date)).toEqual(["2027-02-10", "2027-02-11", "2027-02-12", "2027-02-13"]);
    const [event] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "reservation.modified"));
    expect(event.before).toMatchObject({ checkOut: "2027-02-12", total: 2 * RATE });
    expect(event.after).toMatchObject({ checkOut: "2027-02-14", total: 4 * RATE, difference: 2 * RATE });
    expect(await db.select().from(schema.notificationOutbox).where(eq(schema.notificationOutbox.kind, "booking_modified"))).toHaveLength(1);
  });

  it("keeps the agreed price of existing nights and prices added nights at today's rate", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    await db.update(schema.unitTypes).set({ baseRate: 7_000_000 }).where(eq(schema.unitTypes.id, typeId));
    const preview = await previewStayChange(db, { reservationId: r.id, checkIn: "2027-02-11", checkOut: "2027-02-13", unitId: unitIds[0], now: at("2027-01-05") });
    expect(preview.ok && preview.plan.price.nights.map((n) => n.rate)).toEqual([RATE, 7_000_000]);
    expect(preview.ok && preview.plan.difference).toBe(500_000);
  });

  it("records a refund owed when a paid stay gets shorter, and never loses a refund already paid out", async () => {
    const r = await booking("2027-02-10", "2027-02-14", 0, { full: true });
    const now = at("2027-01-05");
    expect((await change(r.id, "2027-02-10", "2027-02-12", unitIds[0], now)).ok).toBe(true);
    let after = await reload(r.id);
    expect(after.refundAmount).toBe(2 * RATE);
    expect(balanceDue(after)).toBe(0);

    // The refund is paid out, then the guest extends again: they owe those nights again.
    expect((await recordRefundPayout(db, { reservationId: r.id, amount: 2 * RATE, reference: "BCA 123", actor: staff, now })).ok).toBe(true);
    const preview = await previewStayChange(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-02-14", unitId: unitIds[0], now });
    expect(preview.ok && preview.plan).toMatchObject({ balanceAfter: 2 * RATE, refundOutstandingAfter: 0, refundAmount: 2 * RATE });
    expect((await change(r.id, "2027-02-10", "2027-02-14", unitIds[0], now)).ok).toBe(true);
    after = await reload(r.id);
    expect(balanceDue(after)).toBe(2 * RATE);
  });

  it("refuses dates another booking uses and suggests free villas of the same type", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    const next = await booking("2027-02-12", "2027-02-15", 0);
    await booking("2027-02-12", "2027-02-13", 1);
    const result = await previewStayChange(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-02-13", unitId: unitIds[0], now: at("2027-01-05") });
    expect(result).toEqual({ ok: false, error: "dates_unavailable", codes: [next.code], alternatives: [{ id: unitIds[2], code: expect.stringMatching(/-03$/) }] });

    // Taking the suggestion moves and extends in one step.
    expect((await change(r.id, "2027-02-10", "2027-02-13", unitIds[2], at("2027-01-05"))).ok).toBe(true);
    expect(await reload(r.id)).toMatchObject({ unitId: unitIds[2], checkOut: "2027-02-13" });
  });

  it("refuses a villa under maintenance for those nights", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    await db.insert(schema.unitBlocks).values({ unitId: unitIds[0], startDate: "2027-02-12", endDate: "2027-02-14", reason: "Roof" });
    const result = await previewStayChange(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-02-13", unitId: unitIds[0], now: at("2027-01-05") });
    expect(result.ok === false && result.error).toBe("unit_blocked");
  });

  it("refuses the confirmation when the price changed after the preview", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    const now = at("2027-01-05");
    const preview = await previewStayChange(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-02-13", unitId: unitIds[0], now });
    if (!preview.ok) throw new Error();
    await db.update(schema.unitTypes).set({ baseRate: 8_000_000 }).where(eq(schema.unitTypes.id, typeId));
    const applied = await applyStayChange(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-02-13", unitId: unitIds[0], expectedTotal: preview.plan.total, actor: staff, now });
    expect(applied).toEqual({ ok: false, error: "price_changed" });
    expect((await reload(r.id)).checkOut).toBe("2027-02-12");
  });

  it("applies the booking rules: no past arrival, minimum and maximum stay, a real change, the same villa type", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    const now = at("2027-02-05");
    const p = (ci: string, co: string, unitId = unitIds[0]) => previewStayChange(db, { reservationId: r.id, checkIn: ci, checkOut: co, unitId, now });
    expect(await p("2027-02-04", "2027-02-06")).toEqual({ ok: false, error: "check_in_in_past" });
    expect(await p("2027-02-12", "2027-02-10")).toEqual({ ok: false, error: "invalid_dates" });
    expect(await p("2027-02-10", "2027-02-12")).toEqual({ ok: false, error: "no_change" });
    expect(await p("2027-02-10", "2027-03-20")).toEqual({ ok: false, error: "max_stay", maxNights: 30 });
    expect(await p("2027-02-10", "2027-02-12", otherTypeUnitId)).toEqual({ ok: false, error: "unit_not_eligible" });
    await db.update(schema.unitTypes).set({ minStayNights: 3 }).where(eq(schema.unitTypes.id, typeId));
    expect(await p("2027-02-10", "2027-02-11")).toEqual({ ok: false, error: "min_stay", minNights: 3 });
  });

  it("moves to another villa of the same type at the same price", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    const result = await change(r.id, "2027-02-10", "2027-02-12", unitIds[1], at("2027-01-05"));
    expect(result.ok && result.plan).toMatchObject({ moved: true, difference: 0 });
    expect((await reload(r.id)).unitId).toBe(unitIds[1]);
    expect(await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "reservation.moved"))).toHaveLength(1);
    // Nothing changed for the guest, so no message is queued.
    expect(await db.select().from(schema.notificationOutbox).where(eq(schema.notificationOutbox.kind, "booking_modified"))).toHaveLength(0);
  });

  it("is not blocked by a hold that has lapsed", async () => {
    const r = await booking("2027-02-10", "2027-02-12", 0);
    const lapsed = await createHold(db, {
      unitTypeId: typeId, checkIn: "2027-02-12", checkOut: "2027-02-13", adults: 1, children: 0,
      guest: { fullName: "Late", email: "late@example.com" }, locale: "en", source: "website",
      now: at("2027-01-01"), candidateUnitIds: [unitIds[0]],
    });
    if (!lapsed.ok) throw new Error();
    expect((await change(r.id, "2027-02-10", "2027-02-13", unitIds[0], at("2027-01-05"))).ok).toBe(true);
    expect((await reload(lapsed.reservation.id)).status).toBe("expired");
  });

  it("only changes the departure of a guest in house, in the same villa", async () => {
    const r = await booking("2027-02-10", "2027-02-13", 0);
    await checkIn(db, { reservationId: r.id, actor: staff, now: at("2027-02-10") });
    const now = at("2027-02-11");
    const p = (ci: string, co: string, unitId = unitIds[0]) => previewStayChange(db, { reservationId: r.id, checkIn: ci, checkOut: co, unitId, now });
    expect(await p("2027-02-11", "2027-02-13")).toEqual({ ok: false, error: "check_in_fixed" });
    expect(await p("2027-02-10", "2027-02-13", unitIds[1])).toEqual({ ok: false, error: "unit_fixed" });
    expect(await p("2027-02-10", "2027-02-11")).toEqual({ ok: false, error: "check_out_too_early" });
    // Extending into the next arrival is refused with that booking's code.
    const next = await booking("2027-02-14", "2027-02-16", 0);
    expect(await p("2027-02-10", "2027-02-15")).toMatchObject({ ok: false, error: "dates_unavailable", codes: [next.code], alternatives: [] });
    const extended = await change(r.id, "2027-02-10", "2027-02-14", unitIds[0], now);
    // The usual due date (14 days before arrival) has passed: the extra night is due today.
    expect(extended.ok && extended.plan.balanceDueDate).toBe("2027-02-11");
    expect(await reload(r.id)).toMatchObject({ status: "in_house", checkOut: "2027-02-14", totalAmount: 4 * RATE });
  });

  it("refuses holds and finished bookings", async () => {
    const h = await createHold(db, {
      unitTypeId: typeId, checkIn: "2027-02-10", checkOut: "2027-02-12", adults: 1, children: 0,
      guest: { fullName: "H", email: "h@example.com" }, locale: "en", source: "website", now: at("2027-01-05"), candidateUnitIds: [unitIds[0]],
    });
    if (!h.ok) throw new Error();
    const p = (id: string) => previewStayChange(db, { reservationId: id, checkIn: "2027-02-10", checkOut: "2027-02-13", unitId: unitIds[0], now: at("2027-01-05") });
    expect(await p(h.reservation.id)).toEqual({ ok: false, error: "not_confirmed" });
    await cancelReservation(db, { reservationId: h.reservation.id, actor: staff, now: at("2027-01-05") });
    expect(await p(h.reservation.id)).toEqual({ ok: false, error: "final_status" });
  });
});
