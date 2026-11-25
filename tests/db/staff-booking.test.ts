import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { createHold, createPendingPayment, recordPaymentPaid } from "@/domain/booking";
import { recordManualPayment } from "@/domain/operations";
import { balanceDue } from "@/domain/pricing";
import { createStaffBooking, type StaffBookingInput } from "@/domain/staff-booking";
import { createTestDb, type TestDb } from "./test-db";

// 03:00 UTC = 11:00 in Bali.
const at = (date: string) => new Date(`${date}T03:00:00Z`);
const RATE = 6_500_000;
const staff = { type: "staff" as const, id: "fo-1" };

let db: TestDb;
let close: () => Promise<void>;
let typeId: string;
let unitIds: string[];
let otherTypeUnitId: string;

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
  for (const table of [schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests]) {
    await db.delete(table);
  }
});

function input(overrides: Partial<StaffBookingInput>): StaffBookingInput {
  return {
    unitTypeId: typeId,
    checkIn: "2027-02-10",
    checkOut: "2027-02-12",
    adults: 2,
    children: 0,
    guest: { fullName: "Walk In", phone: "+62 811 000" },
    locale: "id",
    source: "walk_in",
    actorId: "fo-1",
    now: at("2027-02-10"),
    payment: { kind: "received", amount: 2 * RATE, method: "cash" },
    ...overrides,
  };
}

describe("staff bookings with money received", () => {
  it("confirms a walk-in paid in full, without an email, and logs who took the money", async () => {
    // Arriving today: the policy wants the full amount now.
    expect(await createStaffBooking(db, input({ payment: { kind: "received", amount: RATE, method: "cash" } }))).toEqual({
      ok: false,
      error: { kind: "invalid_amount", dueNow: 2 * RATE, total: 2 * RATE },
    });
    const result = await createStaffBooking(db, input({}));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.confirmed).toBe(true);
    expect(result.reservation).toMatchObject({ status: "confirmed", source: "walk_in", amountPaid: 2 * RATE });
    const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.reservationId, result.reservation.id));
    expect(payment).toMatchObject({ provider: "manual", purpose: "full", status: "paid", raw: { method: "cash", recordedBy: "fo-1" } });
    const actions = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId, result.reservation.id));
    expect(actions.find((a) => a.action === "reservation.held")?.actorId).toBe("fo-1");
    expect(actions.find((a) => a.action === "payment.received_manual")?.actorId).toBe("fo-1");
    // No email: nothing to send.
    expect(await db.select().from(schema.notificationOutbox)).toHaveLength(0);
  });

  it("accepts the deposit for a later stay and leaves the balance due", async () => {
    const result = await createStaffBooking(
      db,
      input({ source: "direct", guest: { fullName: "Phone", email: "phone@example.com" }, now: at("2027-01-01"), payment: { kind: "received", amount: 3_900_000, method: "bank_transfer", reference: "BCA 0101" } }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.reservation.status).toBe("confirmed");
    expect(balanceDue(result.reservation)).toBe(2 * RATE - 3_900_000);
    expect(await db.select().from(schema.notificationOutbox)).toHaveLength(1);
  });

  it("books the villa staff chose, and refuses one of another type or already taken", async () => {
    const chosen = await createStaffBooking(db, input({ unitId: unitIds[2] }));
    expect(chosen.ok && chosen.reservation.unitId).toBe(unitIds[2]);
    expect(await createStaffBooking(db, input({ unitId: unitIds[2] }))).toEqual({ ok: false, error: { kind: "sold_out" } });
    expect(await createStaffBooking(db, input({ unitId: otherTypeUnitId }))).toEqual({ ok: false, error: { kind: "sold_out" } });
  });

  it("still requires an email on the website, and a way to reach the guest for staff", async () => {
    const base = { unitTypeId: typeId, checkIn: "2027-02-10", checkOut: "2027-02-12", adults: 2, children: 0, locale: "en" as const, now: at("2027-01-01") };
    expect(await createHold(db, { ...base, source: "website", guest: { fullName: "Web", phone: "+62 1" } })).toEqual({ ok: false, error: { kind: "invalid_guest" } });
    expect(await createStaffBooking(db, input({ guest: { fullName: "Nobody" } }))).toEqual({ ok: false, error: { kind: "invalid_guest" } });
    expect(await createStaffBooking(db, input({ guest: { fullName: "Typo", email: "not-an-email", phone: "+62 1" } }))).toEqual({ ok: false, error: { kind: "invalid_guest" } });
  });
});

describe("staff bookings paid by link", () => {
  it("holds the villa for the chosen time; money at the desk confirms it and closes the link", async () => {
    const now = at("2027-01-01");
    const result = await createStaffBooking(db, input({ source: "direct", now, payment: { kind: "link", holdHours: 24 } }));
    if (!result.ok) throw new Error();
    expect(result.reservation.status).toBe("hold");
    expect(result.reservation.holdExpiresAt?.getTime()).toBe(now.getTime() + 24 * 3_600_000);
    expect(await createStaffBooking(db, input({ now, payment: { kind: "link", holdHours: 5 } }))).toEqual({ ok: false, error: { kind: "invalid_guest" } });

    const id = result.reservation.id;
    await createPendingPayment(db, { reservationId: id, provider: "simulated", providerRef: "sim-link", purpose: "deposit", amount: 3_900_000, checkoutUrl: "https://pay.example/x", expiresAt: null });
    const later = new Date(now.getTime() + 3_600_000);
    expect(await recordManualPayment(db, { reservationId: id, amount: 1_000_000, method: "bank_transfer", actor: staff, now: later })).toEqual({ ok: false, error: "invalid_amount" });
    expect(await recordManualPayment(db, { reservationId: id, amount: 3_900_000, method: "bank_transfer", actor: staff, now: later })).toEqual({ ok: true, confirmed: true });
    const [link] = await db.select().from(schema.payments).where(eq(schema.payments.providerRef, "sim-link"));
    expect(link.status).toBe("cancelled");

    // The guest pays through the old link anyway: the money is recorded and owed back.
    await recordPaymentPaid(db, { provider: "simulated", providerRef: "sim-link", amount: 3_900_000, paidAt: later });
    await recordManualPayment(db, { reservationId: id, amount: 2 * RATE - 3_900_000 - 3_900_000, method: "cash", actor: staff, now: later });
    const [r] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, id));
    expect(r.amountPaid).toBe(2 * RATE);
    expect(r.refundAmount).toBeNull();
  });

  it("refuses money for a lapsed hold, an unknown method, or more than is due", async () => {
    const now = at("2027-01-01");
    const result = await createStaffBooking(db, input({ source: "direct", now, payment: { kind: "link", holdHours: 1 } }));
    if (!result.ok) throw new Error();
    const id = result.reservation.id;
    expect(await recordManualPayment(db, { reservationId: id, amount: 3_900_000, method: "crypto", actor: staff, now })).toEqual({ ok: false, error: "invalid_method" });
    expect(await recordManualPayment(db, { reservationId: id, amount: 3_900_000, method: "cash", actor: staff, now: new Date(now.getTime() + 2 * 3_600_000) })).toEqual({
      ok: false,
      error: "hold_expired",
    });
  });

  it("collects the balance of a confirmed booking, then has nothing left to collect", async () => {
    const result = await createStaffBooking(db, input({ now: at("2027-01-01"), payment: { kind: "received", amount: 3_900_000, method: "cash" } }));
    if (!result.ok) throw new Error();
    const id = result.reservation.id;
    const now = at("2027-02-10");
    expect(await recordManualPayment(db, { reservationId: id, amount: 9_200_000, method: "card", actor: staff, now })).toEqual({ ok: false, error: "invalid_amount" });
    expect(await recordManualPayment(db, { reservationId: id, amount: 9_100_000, method: "card", reference: "EDC 77", actor: staff, now })).toEqual({ ok: true, confirmed: false });
    expect(await recordManualPayment(db, { reservationId: id, amount: 1, method: "cash", actor: staff, now })).toEqual({ ok: false, error: "nothing_due" });
    const balance = await db.select().from(schema.payments).where(and(eq(schema.payments.reservationId, id), eq(schema.payments.purpose, "balance")));
    expect(balance).toHaveLength(1);
  });
});

describe("overpayment", () => {
  it("records a refund owed when a cancelled payment link is paid after the desk took the money", async () => {
    const now = at("2027-01-01");
    const result = await createStaffBooking(db, input({ source: "direct", now, payment: { kind: "link", holdHours: 24 } }));
    if (!result.ok) throw new Error();
    const id = result.reservation.id;
    await createPendingPayment(db, { reservationId: id, provider: "simulated", providerRef: "sim-2", purpose: "full", amount: 2 * RATE, checkoutUrl: null, expiresAt: null });
    await recordManualPayment(db, { reservationId: id, amount: 2 * RATE, method: "cash", actor: staff, now });
    expect(await recordPaymentPaid(db, { provider: "simulated", providerRef: "sim-2", amount: 2 * RATE, paidAt: now })).toMatchObject({ kind: "recorded" });
    const [r] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, id));
    expect(r.refundAmount).toBe(2 * RATE);
    expect(balanceDue(r)).toBe(0);
  });
});
