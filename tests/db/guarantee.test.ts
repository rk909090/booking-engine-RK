import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { createHold, createPendingPayment, recordPaymentPaid } from "@/domain/booking";
import { changePayBy, confirmWithoutDeposit, guaranteeDue } from "@/domain/guarantee";
import { recordManualPayment } from "@/domain/operations";
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

async function hold(email: string | null = "guest@example.com") {
  const h = await createHold(db, {
    unitTypeId: typeId, checkIn: "2027-02-10", checkOut: "2027-02-12", adults: 2, children: 0,
    guest: { fullName: "Guest", email, phone: email ? null : "+62 811" }, locale: "en", source: "direct", now, candidateUnitIds: [unitIds[0]],
  });
  if (!h.ok) throw new Error(JSON.stringify(h.error));
  return h.reservation;
}

async function reload(id: string) {
  const [r] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, id));
  return r;
}

const guarantee = (id: string, payBy = "2027-02-10", reason = "Repeat guest, pays on arrival", when = now) =>
  confirmWithoutDeposit(db, { reservationId: id, reason, payBy, actor: staff, now: when });

describe("confirming a hold without the deposit", () => {
  it("confirms at once, keeps the deposit owed with its due date, logs it and tells the guest", async () => {
    const h = await hold();
    expect(await guarantee(h.id)).toEqual({ ok: true });
    const r = await reload(h.id);
    expect(r).toMatchObject({ status: "confirmed", holdExpiresAt: null, amountPaid: 0 });
    expect(r.guarantee).toMatchObject({ reason: "Repeat guest, pays on arrival", payBy: "2027-02-10", givenBy: "fo-1" });
    expect(guaranteeDue(r, "2027-02-10")).toMatchObject({ amount: r.depositAmount, payBy: "2027-02-10", overdue: false });
    expect(guaranteeDue(r, "2027-02-11")?.overdue).toBe(true);

    const [event] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "reservation.guaranteed"));
    expect(event.after).toMatchObject({ reason: "Repeat guest, pays on arrival", payBy: "2027-02-10", deposit: r.depositAmount });
    const [mail] = await db.select().from(schema.notificationOutbox);
    expect(mail).toMatchObject({ kind: "booking_confirmed", recipient: "guest@example.com" });
  });

  it("needs a reason, a due date from today to check-out, and a live hold", async () => {
    const h = await hold(null);
    expect(await guarantee(h.id, "2027-02-10", "  ")).toEqual({ ok: false, error: "reason_required" });
    expect(await guarantee(h.id, "2027-01-04")).toEqual({ ok: false, error: "invalid_pay_by" });
    expect(await guarantee(h.id, "2027-02-13")).toEqual({ ok: false, error: "invalid_pay_by" });
    expect(await guarantee(h.id, "not-a-date")).toEqual({ ok: false, error: "invalid_pay_by" });
    expect(await guarantee(h.id, "2027-02-10", "VIP", at("2027-01-30"))).toEqual({ ok: false, error: "hold_expired" });
    expect(await guarantee(h.id, "2027-02-12")).toEqual({ ok: true });
    expect(await guarantee(h.id)).toEqual({ ok: false, error: "not_hold" });
    // No email address: nothing queued.
    expect(await db.select().from(schema.notificationOutbox)).toHaveLength(0);
  });

  it("stops owing once the deposit is paid, at the desk or through a payment link still open", async () => {
    const h = await hold();
    await guarantee(h.id);
    await recordManualPayment(db, { reservationId: h.id, amount: h.depositAmount - 1, method: "cash", actor: staff, now });
    expect(guaranteeDue(await reload(h.id), "2027-02-11")).toMatchObject({ amount: 1, overdue: true });
    await recordManualPayment(db, { reservationId: h.id, amount: 1, method: "cash", actor: staff, now });
    expect(guaranteeDue(await reload(h.id), "2027-02-11")).toBeNull();
  });

  it("records a payment link paid after the guarantee as a payment, not a second confirmation", async () => {
    const h = await hold();
    await createPendingPayment(db, { reservationId: h.id, provider: "simulated", providerRef: "link-1", purpose: "deposit", amount: h.depositAmount, checkoutUrl: null, expiresAt: null });
    await guarantee(h.id);
    expect(await recordPaymentPaid(db, { provider: "simulated", providerRef: "link-1", amount: h.depositAmount, paidAt: now })).toMatchObject({ kind: "recorded" });
    const r = await reload(h.id);
    expect(r).toMatchObject({ status: "confirmed", amountPaid: h.depositAmount });
    expect(guaranteeDue(r, "2027-02-11")).toBeNull();
  });
});

describe("moving the deposit due date", () => {
  it("moves it within the stay and logs the change; refuses once nothing is owed", async () => {
    const h = await hold();
    expect(await changePayBy(db, { reservationId: h.id, payBy: "2027-02-11", actor: staff, now })).toEqual({ ok: false, error: "not_guaranteed" });
    await guarantee(h.id, "2027-01-20");
    expect(await changePayBy(db, { reservationId: h.id, payBy: "2027-02-13", actor: staff, now })).toEqual({ ok: false, error: "invalid_pay_by" });
    expect(await changePayBy(db, { reservationId: h.id, payBy: "2027-02-11", actor: staff, now })).toEqual({ ok: true });
    expect((await reload(h.id)).guarantee).toMatchObject({ payBy: "2027-02-11", reason: "Repeat guest, pays on arrival" });
    const [event] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "reservation.pay_by_changed"));
    expect(event).toMatchObject({ before: { payBy: "2027-01-20" }, after: { payBy: "2027-02-11" } });

    await recordManualPayment(db, { reservationId: h.id, amount: h.depositAmount, method: "bank_transfer", actor: staff, now });
    expect(await changePayBy(db, { reservationId: h.id, payBy: "2027-02-10", actor: staff, now })).toEqual({ ok: false, error: "not_guaranteed" });
  });
});

describe("staff bookings confirmed without the deposit", () => {
  const base = {
    checkIn: "2027-02-10",
    checkOut: "2027-02-12",
    adults: 2,
    children: 0,
    guest: { fullName: "Agent Guest", phone: "+62 812" },
    locale: "id" as const,
    source: "agent" as const,
    actorId: "fo-1",
    role: "front_office",
    now,
  };

  it("confirms with nothing paid, and refuses a bad due date or missing reason before holding anything", async () => {
    const input = { ...base, unitTypeId: typeId };
    expect(await createStaffBooking(db, { ...input, payment: { kind: "guarantee", reason: "Agent", payBy: "2027-02-20" } })).toEqual({
      ok: false,
      error: { kind: "guarantee", error: "invalid_pay_by" },
    });
    expect(await createStaffBooking(db, { ...input, payment: { kind: "guarantee", reason: " ", payBy: "2027-02-10" } })).toEqual({
      ok: false,
      error: { kind: "guarantee", error: "reason_required" },
    });
    expect(await db.select().from(schema.reservations)).toHaveLength(0);

    const ok = await createStaffBooking(db, { ...input, payment: { kind: "guarantee", reason: "Agent, invoice monthly", payBy: "2027-02-12" } });
    if (!ok.ok) throw new Error(JSON.stringify(ok.error));
    expect(ok.confirmed).toBe(true);
    expect(ok.reservation).toMatchObject({ status: "confirmed", amountPaid: 0, totalAmount: 2 * RATE, guarantee: { payBy: "2027-02-12", reason: "Agent, invoice monthly" } });
    expect(guaranteeDue(ok.reservation, "2027-02-13")?.overdue).toBe(true);
  });
});
