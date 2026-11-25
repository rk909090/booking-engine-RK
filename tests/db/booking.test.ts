import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import {
  cancelReservation,
  createHold,
  createPendingPayment,
  expireHolds,
  availabilityCalendar,
  findGuestReservation,
  recordPaymentPaid,
  searchAvailability,
  type HoldInput,
} from "@/domain/booking";
import { createTestDb, type TestDb } from "./test-db";

// 25 Nov 2026, 11:00 in Bali.
const NOW = new Date("2026-11-25T03:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

let db: TestDb;
let close: () => Promise<void>;
let riverPavilion: typeof schema.unitTypes.$inferSelect;
let riverUnits: (typeof schema.units.$inferSelect)[];

function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  while (current && typeof current === "object") {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function holdInput(overrides: Partial<HoldInput> = {}): HoldInput {
  return {
    unitTypeId: riverPavilion.id,
    checkIn: "2027-02-10",
    checkOut: "2027-02-13",
    adults: 2,
    children: 0,
    guest: { fullName: "Ana Guest", email: "Ana@Example.com" },
    locale: "en",
    source: "website",
    now: NOW,
    ...overrides,
  };
}

async function hold(overrides: Partial<HoldInput> = {}) {
  const result = await createHold(db, holdInput(overrides));
  if (!result.ok) throw new Error(`hold failed: ${JSON.stringify(result.error)}`);
  return result;
}

beforeAll(async () => {
  const test = await createTestDb();
  db = test.db;
  close = () => test.client.close();
  await seedSampleData(db);
  [riverPavilion] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.slug, "river-pavilion"));
  riverUnits = await db
    .select()
    .from(schema.units)
    .where(eq(schema.units.unitTypeId, riverPavilion.id))
    .orderBy(schema.units.code);
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(schema.notificationOutbox);
  await db.delete(schema.payments);
  await db.delete(schema.reservations);
  await db.delete(schema.guests);
  await db.delete(schema.rateSeasons);
});

describe("searchAvailability", () => {
  it("lists every published villa type with free units and a price", async () => {
    const results = await searchAvailability(db, {
      checkIn: "2027-02-10",
      checkOut: "2027-02-13",
      adults: 2,
      children: 0,
      now: NOW,
    });
    expect(results).toHaveLength(4);
    const river = results.find((r) => r.unitType.id === riverPavilion.id)!;
    expect(river.totalUnits).toBe(3);
    expect(river.freeUnits).toBe(3);
    expect(river.fitsGuests).toBe(true);
    expect(river.quote.ok && river.quote.quote.total).toBe(3 * riverPavilion.baseRate);
  });

  it("filters by property and counts held units as taken", async () => {
    await hold();
    const results = await searchAvailability(db, {
      checkIn: "2027-02-11",
      checkOut: "2027-02-12",
      adults: 3,
      children: 0,
      propertySlug: "ubud",
      now: NOW,
    });
    expect(results.every((r) => r.property.slug === "ubud")).toBe(true);
    const river = results.find((r) => r.unitType.id === riverPavilion.id)!;
    expect(river.freeUnits).toBe(2);
    expect(river.fitsGuests).toBe(false);
  });
});

describe("createHold", () => {
  it("holds a unit for the property's hold time with price and policy snapshots", async () => {
    const { reservation, quote } = await hold();
    expect(reservation.status).toBe("hold");
    expect(reservation.code).toMatch(/^ATR-[2-9A-HJKMNP-Z]{8}$/);
    expect(reservation.holdExpiresAt?.toISOString()).toBe(minutes(15).toISOString());
    expect(reservation.totalAmount).toBe(quote.total);
    expect(reservation.depositAmount).toBe(quote.dueNow);
    expect(reservation.priceSnapshot?.nights).toHaveLength(3);
    expect(reservation.policySnapshot?.cancellationTiers.length).toBeGreaterThan(0);
    const [guest] = await db.select().from(schema.guests).where(eq(schema.guests.id, reservation.guestId));
    expect(guest.email).toBe("ana@example.com");
  });

  it("sells out when every unit of the type is held, then frees units once holds expire", async () => {
    for (let i = 0; i < 3; i += 1) await hold();
    expect(await createHold(db, holdInput())).toEqual({ ok: false, error: { kind: "sold_out" } });

    const later = await createHold(db, holdInput({ now: minutes(16) }));
    expect(later.ok).toBe(true);
    const statuses = (await db.select({ s: schema.reservations.status }).from(schema.reservations)).map((r) => r.s);
    expect(statuses.filter((s) => s === "expired")).toHaveLength(3);
  });

  it("moves on to the next unit when the first was taken a moment ago", async () => {
    await hold({ candidateUnitIds: [riverUnits[0].id] });
    const second = await hold({ candidateUnitIds: [riverUnits[0].id, riverUnits[1].id] });
    expect(second.reservation.unitId).toBe(riverUnits[1].id);
  });

  it("returns sold out and leaves no guest behind when every candidate was taken", async () => {
    await hold({ candidateUnitIds: [riverUnits[0].id] });
    const guestsBefore = (await db.select().from(schema.guests)).length;
    const result = await createHold(db, holdInput({ candidateUnitIds: [riverUnits[0].id] }));
    expect(result).toEqual({ ok: false, error: { kind: "sold_out" } });
    expect((await db.select().from(schema.guests)).length).toBe(guestsBefore);
  });

  it("rejects too many guests, bad contact details, unknown types and invalid stays", async () => {
    expect(await createHold(db, holdInput({ adults: 3 }))).toEqual({
      ok: false,
      error: { kind: "too_many_guests", maxGuests: 2 },
    });
    expect((await createHold(db, holdInput({ guest: { fullName: "X", email: "not-an-email" } }))).ok).toBe(false);
    expect(
      await createHold(db, holdInput({ unitTypeId: "00000000-0000-0000-0000-000000000000" })),
    ).toEqual({ ok: false, error: { kind: "unknown_unit_type" } });
    expect(await createHold(db, holdInput({ checkIn: "2026-11-20", checkOut: "2026-11-23" }))).toEqual({
      ok: false,
      error: { kind: "quote", error: { kind: "check_in_in_past" } },
    });
  });

  it("prices seasonal nights and enforces the season's minimum stay", async () => {
    await db.insert(schema.rateSeasons).values({
      unitTypeId: riverPavilion.id,
      name: "High",
      startDate: "2026-12-20",
      endDate: "2027-01-05",
      nightlyRate: 9_000_000,
      minStayNights: 5,
    });
    expect(await createHold(db, holdInput({ checkIn: "2026-12-22", checkOut: "2026-12-25" }))).toEqual({
      ok: false,
      error: { kind: "quote", error: { kind: "min_stay", minNights: 5 } },
    });
    const { quote } = await hold({ checkIn: "2026-12-22", checkOut: "2026-12-27" });
    expect(quote.total).toBe(5 * 9_000_000);
    expect(quote.payInFull).toBe(false);
  });
});

describe("rate seasons", () => {
  it("cannot overlap for the same villa type", async () => {
    await db.insert(schema.rateSeasons).values({
      unitTypeId: riverPavilion.id,
      name: "A",
      startDate: "2027-07-01",
      endDate: "2027-08-01",
      nightlyRate: 1,
    });
    const error = await db
      .insert(schema.rateSeasons)
      .values({ unitTypeId: riverPavilion.id, name: "B", startDate: "2027-07-31", endDate: "2027-08-10", nightlyRate: 1 })
      .then(() => undefined, (e: unknown) => e);
    expect(sqlState(error)).toBe("23P01");
  });
});

describe("recordPaymentPaid", () => {
  async function heldWithPayment(ref: string, overrides: Partial<HoldInput> = {}) {
    const { reservation } = await hold(overrides);
    await createPendingPayment(db, {
      reservationId: reservation.id,
      provider: "simulated",
      providerRef: ref,
      purpose: "deposit",
      amount: reservation.depositAmount,
      checkoutUrl: null,
      expiresAt: reservation.holdExpiresAt,
    });
    return reservation;
  }

  it("confirms the booking, records the amount and queues a confirmation email", async () => {
    const r = await heldWithPayment("pay-1");
    const outcome = await recordPaymentPaid(db, {
      provider: "simulated",
      providerRef: "pay-1",
      amount: r.depositAmount,
      paidAt: minutes(3),
    });
    expect(outcome).toEqual({ kind: "confirmed", reservationId: r.id });
    const [after] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, r.id));
    expect(after.status).toBe("confirmed");
    expect(after.amountPaid).toBe(r.depositAmount);
    expect(after.holdExpiresAt).toBeNull();
    const outbox = await db.select().from(schema.notificationOutbox);
    expect(outbox.map((o) => [o.kind, o.recipient])).toEqual([["booking_confirmed", "ana@example.com"]]);
  });

  it("ignores a second delivery of the same payment", async () => {
    const r = await heldWithPayment("pay-2");
    const args = { provider: "simulated" as const, providerRef: "pay-2", amount: r.depositAmount, paidAt: minutes(3) };
    await recordPaymentPaid(db, args);
    expect(await recordPaymentPaid(db, args)).toEqual({ kind: "already_processed", reservationId: r.id });
    const [after] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, r.id));
    expect(after.amountPaid).toBe(r.depositAmount);
  });

  it("refuses an amount that does not match and an unknown payment", async () => {
    const r = await heldWithPayment("pay-3");
    expect(
      await recordPaymentPaid(db, { provider: "simulated", providerRef: "pay-3", amount: 1, paidAt: minutes(3) }),
    ).toEqual({ kind: "amount_mismatch", reservationId: r.id, expected: r.depositAmount, received: 1 });
    expect(
      await recordPaymentPaid(db, { provider: "simulated", providerRef: "nope", amount: 1, paidAt: minutes(3) }),
    ).toEqual({ kind: "unknown_payment" });
  });

  it("still confirms a late payment when the unit is free", async () => {
    const r = await heldWithPayment("pay-4", { candidateUnitIds: [riverUnits[0].id] });
    await expireHolds(db, minutes(20));
    expect(
      await recordPaymentPaid(db, { provider: "simulated", providerRef: "pay-4", amount: r.depositAmount, paidAt: minutes(21) }),
    ).toEqual({ kind: "confirmed", reservationId: r.id });
  });

  it("flags a refund when the unit was rebooked after the hold lapsed", async () => {
    const r = await heldWithPayment("pay-5", { candidateUnitIds: [riverUnits[0].id] });
    await hold({ now: minutes(20), candidateUnitIds: [riverUnits[0].id], guest: { fullName: "B", email: "b@example.com" } });
    const outcome = await recordPaymentPaid(db, {
      provider: "simulated",
      providerRef: "pay-5",
      amount: r.depositAmount,
      paidAt: minutes(21),
    });
    expect(outcome).toEqual({ kind: "needs_refund", reservationId: r.id, reason: "unit_taken_after_expiry" });
    const [after] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, r.id));
    expect(after.status).toBe("expired");
    expect(after.refundAmount).toBe(r.depositAmount);
  });
});

describe("cancelReservation", () => {
  it("refunds the full deposit 14 or more days before arrival", async () => {
    const { reservation: r } = await hold();
    await createPendingPayment(db, {
      reservationId: r.id,
      provider: "simulated",
      providerRef: "pay-c1",
      purpose: "deposit",
      amount: r.depositAmount,
      checkoutUrl: null,
      expiresAt: null,
    });
    await recordPaymentPaid(db, { provider: "simulated", providerRef: "pay-c1", amount: r.depositAmount, paidAt: minutes(2) });

    const result = await cancelReservation(db, { reservationId: r.id, actor: { type: "guest" }, now: minutes(60) });
    expect(result).toEqual({ ok: true, refund: r.depositAmount, fee: 0 });
    expect(await cancelReservation(db, { reservationId: r.id, actor: { type: "guest" }, now: minutes(61) })).toEqual({
      ok: false,
      error: "not_cancellable",
    });
  });

  it("keeps the deposit under the policy close to arrival", async () => {
    // Arrives 10 days after NOW: inside the 50% tier, and paying in full.
    const { reservation: r } = await hold({ checkIn: "2026-12-05", checkOut: "2026-12-08" });
    expect(r.depositAmount).toBe(r.totalAmount);
    await createPendingPayment(db, {
      reservationId: r.id,
      provider: "simulated",
      providerRef: "pay-c2",
      purpose: "full",
      amount: r.totalAmount,
      checkoutUrl: null,
      expiresAt: null,
    });
    await recordPaymentPaid(db, { provider: "simulated", providerRef: "pay-c2", amount: r.totalAmount, paidAt: minutes(2) });
    const result = await cancelReservation(db, { reservationId: r.id, actor: { type: "staff", id: "s1" }, now: minutes(5) });
    expect(result).toEqual({ ok: true, refund: r.totalAmount / 2, fee: r.totalAmount / 2 });
  });
});

describe("findGuestReservation", () => {
  it("needs both the code and the guest's email, in any letter case", async () => {
    const { reservation: r } = await hold();
    expect((await findGuestReservation(db, r.code.toLowerCase(), "ANA@example.com"))?.reservation.id).toBe(r.id);
    expect(await findGuestReservation(db, r.code, "someone@example.com")).toBeNull();
  });
});

describe("availabilityCalendar", () => {
  it("counts free units per night, ignoring expired holds", async () => {
    await hold({ checkIn: "2027-02-10", checkOut: "2027-02-12" });
    await hold({ checkIn: "2027-02-11", checkOut: "2027-02-12", now: minutes(-30) }); // lapsed hold
    const days = await availabilityCalendar(db, { unitTypeId: riverPavilion.id, from: "2027-02-09", days: 5, now: NOW });
    expect(days).toEqual([
      { date: "2027-02-09", free: 3 },
      { date: "2027-02-10", free: 2 },
      { date: "2027-02-11", free: 2 },
      { date: "2027-02-12", free: 3 },
      { date: "2027-02-13", free: 3 },
    ]);
  });
});
