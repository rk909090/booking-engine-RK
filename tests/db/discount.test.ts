import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { createHold, createPendingPayment, recordPaymentPaid } from "@/domain/booking";
import { setDiscount } from "@/domain/discount";
import { applyStayChange, previewStayChange } from "@/domain/modify";
import { recordRefundPayout } from "@/domain/operations";
import { balanceDue } from "@/domain/pricing";
import { createStaffBooking } from "@/domain/staff-booking";
import { createTestDb, type TestDb } from "./test-db";

const at = (date: string) => new Date(`${date}T03:00:00Z`);
const RATE = 6_500_000;
const staff = { type: "staff" as const, id: "fo-1" };
const now = at("2027-01-05");

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
  for (const table of [schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests]) await db.delete(table);
  await db.update(schema.properties).set({ serviceRateBp: 0, taxRateBp: 0 }).where(eq(schema.properties.id, propertyId));
});

async function booking(opts: { full?: boolean } = {}) {
  const h = await createHold(db, {
    unitTypeId: typeId, checkIn: "2027-02-10", checkOut: "2027-02-12", adults: 2, children: 0,
    guest: { fullName: "Guest", email: "guest@example.com" }, locale: "en", source: "direct", now: at("2027-01-01"), candidateUnitIds: [unitIds[0]],
  });
  if (!h.ok) throw new Error(JSON.stringify(h.error));
  const amount = opts.full ? h.reservation.totalAmount : h.reservation.depositAmount;
  await createPendingPayment(db, { reservationId: h.reservation.id, provider: "simulated", providerRef: `ref-${h.reservation.code}`, purpose: "deposit", amount, checkoutUrl: null, expiresAt: null });
  await recordPaymentPaid(db, { provider: "simulated", providerRef: `ref-${h.reservation.code}`, amount, paidAt: at("2027-01-01") });
  return h.reservation;
}

async function reload(id: string) {
  const [r] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, id));
  return r;
}

const give = (id: string, discount: Parameters<typeof setDiscount>[1]["discount"], role = "front_office", reason = "Repeat guest") =>
  setDiscount(db, { reservationId: id, discount, reason, role, actor: staff, now });

describe("discounts on a booking", () => {
  it("takes the discount off the nights, then charges service and tax on the rest", async () => {
    await db.update(schema.properties).set({ serviceRateBp: 1000, taxRateBp: 1000 }).where(eq(schema.properties.id, propertyId));
    const r = await booking();
    expect(r.totalAmount).toBe(15_730_000); // 13,000,000 + 10% service + 10% tax
    expect(await give(r.id, { kind: "percent", bp: 1000 })).toEqual({ ok: true, total: 14_157_000, discountAmount: 1_300_000 });
    const after = await reload(r.id);
    expect(after).toMatchObject({ subtotalAmount: 13_000_000, discountAmount: 1_300_000, serviceAmount: 1_170_000, taxAmount: 1_287_000, totalAmount: 14_157_000 });
    expect(after.discount).toMatchObject({ kind: "percent", bp: 1000, reason: "Repeat guest", givenBy: "fo-1" });
    const [event] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "reservation.discounted"));
    expect(event.before).toMatchObject({ total: 15_730_000 });
  });

  it("holds each role to its ceiling: front office 10%, branch manager 50%, housekeeping none", async () => {
    const r = await booking();
    expect(await give(r.id, { kind: "percent", bp: 1500 })).toEqual({ ok: false, error: "over_limit", limitBp: 1000 });
    expect(await give(r.id, { kind: "amount", amount: 1_300_001 })).toEqual({ ok: false, error: "over_limit", limitBp: 1000 });
    expect((await give(r.id, { kind: "amount", amount: 1_300_000 })).ok).toBe(true);
    expect((await give(r.id, { kind: "percent", bp: 1500 }, "branch_manager")).ok).toBe(true);
    expect(await give(r.id, { kind: "percent", bp: 6000 }, "branch_manager")).toEqual({ ok: false, error: "over_limit", limitBp: 5000 });
    expect(await give(r.id, { kind: "percent", bp: 500 }, "housekeeping")).toEqual({ ok: false, error: "over_limit", limitBp: 0 });
  });

  it("requires a reason and a sensible value, and is not for holds", async () => {
    const r = await booking();
    expect(await give(r.id, { kind: "percent", bp: 500 }, "front_office", "  ")).toEqual({ ok: false, error: "reason_required" });
    expect(await give(r.id, { kind: "percent", bp: 0 })).toEqual({ ok: false, error: "invalid_discount" });
    expect(await give(r.id, { kind: "percent", bp: 10_001 }, "branch_manager")).toEqual({ ok: false, error: "invalid_discount" });
    const h = await createHold(db, {
      unitTypeId: typeId, checkIn: "2027-03-10", checkOut: "2027-03-12", adults: 1, children: 0,
      guest: { fullName: "H", email: "h@example.com" }, locale: "en", source: "website", now, candidateUnitIds: [unitIds[1]],
    });
    if (!h.ok) throw new Error();
    expect(await give(h.reservation.id, { kind: "percent", bp: 500 })).toEqual({ ok: false, error: "not_allowed" });
  });

  it("owes back what a paid guest overpaid, and charges again after removal without losing a paid-out refund", async () => {
    const r = await booking({ full: true });
    await give(r.id, { kind: "percent", bp: 1000 });
    let after = await reload(r.id);
    expect(after.refundAmount).toBe(1_300_000);
    expect(balanceDue(after)).toBe(0);
    await recordRefundPayout(db, { reservationId: r.id, amount: 1_300_000, reference: "BCA", actor: staff, now });
    expect(await give(r.id, null)).toEqual({ ok: true, total: 2 * RATE, discountAmount: 0 });
    after = await reload(r.id);
    expect(after.discount).toBeNull();
    expect(balanceDue(after)).toBe(1_300_000);
  });

  it("follows the nights when the dates change (a share) and stays fixed (an amount)", async () => {
    const r = await booking();
    await give(r.id, { kind: "percent", bp: 1000 });
    const preview = await previewStayChange(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-02-13", unitId: unitIds[0], now });
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.plan.price.discount).toBe(1_950_000);
    expect(preview.plan.total).toBe(3 * RATE - 1_950_000);
    await applyStayChange(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-02-13", unitId: unitIds[0], expectedTotal: preview.plan.total, actor: staff, now });
    expect(await reload(r.id)).toMatchObject({ discountAmount: 1_950_000, totalAmount: 3 * RATE - 1_950_000 });

    await give(r.id, { kind: "amount", amount: 1_000_000 });
    const shorter = await previewStayChange(db, { reservationId: r.id, checkIn: "2027-02-10", checkOut: "2027-02-11", unitId: unitIds[0], now });
    expect(shorter.ok && shorter.plan.price.discount).toBe(1_000_000);
  });
});

describe("discounts on staff bookings", () => {
  const base = {
    unitTypeId: typeId,
    checkIn: "2027-02-10",
    checkOut: "2027-02-12",
    adults: 2,
    children: 0,
    guest: { fullName: "Walk In", phone: "+62 811" },
    locale: "id" as const,
    source: "walk_in" as const,
    actorId: "fo-1",
    role: "front_office",
    now: at("2027-02-10"),
  };

  it("prices the deposit on the discounted total and refuses discounts over the ceiling before holding anything", async () => {
    const input = { ...base, unitTypeId: typeId };
    const over = await createStaffBooking(db, { ...input, discount: { kind: "percent", bp: 2000, reason: "Friend" }, payment: { kind: "received", amount: 1, method: "cash" } });
    expect(over).toEqual({ ok: false, error: { kind: "over_limit", limitBp: 1000 } });
    expect(await db.select().from(schema.reservations)).toHaveLength(0);

    const tooLittle = await createStaffBooking(db, { ...input, discount: { kind: "percent", bp: 1000, reason: "Corporate" }, payment: { kind: "received", amount: 2 * RATE, method: "cash" } });
    expect(tooLittle).toEqual({ ok: false, error: { kind: "invalid_amount", dueNow: 11_700_000, total: 11_700_000 } });
    const ok = await createStaffBooking(db, { ...input, discount: { kind: "percent", bp: 1000, reason: "Corporate" }, payment: { kind: "received", amount: 11_700_000, method: "cash" } });
    if (!ok.ok) throw new Error(JSON.stringify(ok.error));
    expect(ok.reservation).toMatchObject({ status: "confirmed", totalAmount: 11_700_000, discountAmount: 1_300_000, discount: { reason: "Corporate", givenBy: "fo-1" } });
    expect(await createStaffBooking(db, { ...input, discount: { kind: "percent", bp: 500, reason: " " }, payment: { kind: "received", amount: 1, method: "cash" } })).toEqual({
      ok: false,
      error: { kind: "invalid_discount" },
    });
  });
});
