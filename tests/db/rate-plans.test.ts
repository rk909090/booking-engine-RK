import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { cancelReservation, createHold, createPendingPayment, recordPaymentPaid, type HoldInput } from "@/domain/booking";
import { invoiceData } from "@/domain/folio";
import { checkPromo } from "@/domain/promos";
import { addArrivalClosure, addSeason, createPromo, setPromoActive, updateOffers, updateTypeRates, type PromoInput } from "@/domain/rates";
import { createStaffBooking } from "@/domain/staff-booking";
import { createTestDb, type TestDb } from "./test-db";

// 03:00 UTC = 11:00 in Bali.
const at = (date: string, utc = "03:00") => new Date(`${date}T${utc}:00Z`);
const RATE = 6_500_000;
const manager = { type: "staff" as const, id: "bm-1" };

let db: TestDb;
let close: () => Promise<void>;
let typeId: string;
let otherTypeId: string;
let propertyId: string;

beforeAll(async () => {
  const test = await createTestDb();
  db = test.db;
  close = () => test.client.close();
  await seedSampleData(db);
  const [type] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.slug, "river-pavilion"));
  const [other] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.slug, "canopy-villa"));
  typeId = type.id;
  otherTypeId = other.id;
  propertyId = type.propertyId;
});
afterAll(async () => close());
beforeEach(async () => {
  for (const table of [schema.folioCharges, schema.invoices, schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests, schema.promoCodes, schema.arrivalClosures]) {
    await db.delete(table);
  }
  await db.delete(schema.rateSeasons).where(eq(schema.rateSeasons.name, "Test season"));
  await updateOffers(db, { propertyId, nonRefundableBp: 1000, breakfastPerGuest: 250_000, earlyBirdDays: null, earlyBirdBp: null, longStayTiers: [], actor: manager });
});

function hold(overrides: Partial<HoldInput> = {}) {
  return createHold(db, {
    unitTypeId: typeId,
    checkIn: "2027-03-01",
    checkOut: "2027-03-04",
    adults: 2,
    children: 0,
    guest: { fullName: "Guest", email: "g@example.com" },
    locale: "en",
    source: "website",
    now: at("2027-01-05"),
    ...overrides,
  });
}

function promo(overrides: Partial<PromoInput> = {}) {
  return createPromo(db, {
    propertyId, code: "bali 10", kind: "percent", valueBp: 1000, amount: null, bookFrom: null, bookUntil: null, stayFrom: null, stayUntil: null,
    minNights: null, unitTypeIds: [], maxUses: null, note: null, actor: manager, ...overrides,
  });
}

describe("promo codes", () => {
  it("applies a code, counts its uses, and frees a use when a hold lapses", async () => {
    expect(await promo({ maxUses: 1 })).toMatchObject({ ok: true });
    const first = await hold({ promoCode: "Bali10" });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    expect(first.reservation).toMatchObject({ discountAmount: 3 * RATE * 0.1, ratePlan: "standard" });
    expect(first.reservation.promoCodeId).toBeTruthy();
    expect(first.reservation.priceSnapshot?.offer).toEqual({ kind: "promo", code: "BALI10", amount: 3 * RATE * 0.1 });

    expect(await hold({ promoCode: "BALI10", now: at("2027-01-05", "03:05") })).toEqual({ ok: false, error: { kind: "promo", error: "promo_used_up" } });
    // The first hold lapsed after 15 minutes: its use is free again.
    expect((await hold({ promoCode: "BALI10", now: at("2027-01-05", "04:00") })).ok).toBe(true);
  });

  it("checks booking dates, arrival dates, nights, villa type and whether it is switched on", async () => {
    const made = await promo({ code: "EARLY", bookUntil: "2027-01-31", stayFrom: "2027-03-01", stayUntil: "2027-03-31", minNights: 3, unitTypeIds: [typeId] });
    const check = (o: { today?: string; checkIn?: string; checkOut?: string; unitTypeId?: string }) =>
      checkPromo(db, { propertyId, unitTypeId: o.unitTypeId ?? typeId, code: "early", checkIn: o.checkIn ?? "2027-03-01", checkOut: o.checkOut ?? "2027-03-04", today: o.today ?? "2027-01-05", now: at("2027-01-05") });
    expect((await check({})).ok).toBe(true);
    expect(await check({ today: "2027-02-01" })).toEqual({ ok: false, error: "promo_ended" });
    expect(await check({ checkIn: "2027-04-01", checkOut: "2027-04-05" })).toEqual({ ok: false, error: "promo_stay_dates" });
    expect(await check({ checkOut: "2027-03-03" })).toEqual({ ok: false, error: "promo_min_nights" });
    expect(await check({ unitTypeId: otherTypeId })).toEqual({ ok: false, error: "promo_villa" });
    await setPromoActive(db, { promoId: (made as { id: string }).id, active: false, actor: manager });
    expect(await check({})).toEqual({ ok: false, error: "promo_not_found" });
    expect(await promo({ code: "EARLY" })).toEqual({ ok: false, error: "code_taken" });
  });
});

describe("rate plans on bookings", () => {
  it("non-refundable is paid in full and refunds nothing when cancelled", async () => {
    const h = await hold({ ratePlan: "non_refundable" });
    if (!h.ok) throw new Error(JSON.stringify(h.error));
    const total = 3 * RATE * 0.9;
    expect(h.reservation).toMatchObject({ ratePlan: "non_refundable", totalAmount: total, depositAmount: total, balanceDueDate: null });
    expect(h.reservation.policySnapshot).toMatchObject({ cancellationTiers: [{ minDaysBefore: 0, chargeBp: 10_000 }], depositRateBp: 10_000 });
    await createPendingPayment(db, { reservationId: h.reservation.id, provider: "simulated", providerRef: "nr-1", purpose: "full", amount: total, checkoutUrl: null, expiresAt: null });
    await recordPaymentPaid(db, { provider: "simulated", providerRef: "nr-1", amount: total, paidAt: at("2027-01-05") });
    // Cancelled two months before arrival: still no refund.
    expect(await cancelReservation(db, { reservationId: h.reservation.id, actor: { type: "guest" }, now: at("2027-01-06") })).toEqual({ ok: true, refund: 0, fee: total });
  });

  it("breakfast is stored apart and shown on the invoice", async () => {
    const h = await hold({ ratePlan: "breakfast", adults: 2, children: 0 });
    if (!h.ok) throw new Error(JSON.stringify(h.error));
    expect(h.reservation).toMatchObject({ breakfastAmount: 250_000 * 2 * 3, totalAmount: 3 * RATE + 1_500_000 });
    const invoice = await invoiceData(db, { reservationId: h.reservation.id });
    expect(invoice?.lines.find((l) => l.kind === "breakfast")).toMatchObject({ amount: 1_500_000, quantity: 3 });
    expect(invoice?.lines.some((l) => l.kind === "other")).toBe(false);
  });

  it("refuses a plan the property switched off", async () => {
    await updateOffers(db, { propertyId, nonRefundableBp: null, breakfastPerGuest: null, earlyBirdDays: null, earlyBirdBp: null, longStayTiers: [], actor: manager });
    expect(await hold({ ratePlan: "breakfast" })).toEqual({ ok: false, error: { kind: "quote", error: { kind: "plan_unavailable" } } });
  });

  it("a staff discount smaller than the automatic one is refused, not silently dropped", async () => {
    await updateOffers(db, { propertyId, nonRefundableBp: null, breakfastPerGuest: null, earlyBirdDays: null, earlyBirdBp: null, longStayTiers: [{ minNights: 3, bp: 1500 }], actor: manager });
    const base = {
      unitTypeId: typeId, checkIn: "2027-03-01", checkOut: "2027-03-04", adults: 2, children: 0, guest: { fullName: "Walk In", phone: "+62 811" },
      locale: "id" as const, source: "direct" as const, actorId: "bm-1", role: "branch_manager", now: at("2027-02-20"),
      payment: { kind: "link" as const, holdHours: 24 },
    };
    expect(await createStaffBooking(db, { ...base, discount: { kind: "percent", bp: 1000, reason: "Repeat guest" } })).toEqual({ ok: false, error: { kind: "smaller_than_offer" } });
    const bigger = await createStaffBooking(db, { ...base, discount: { kind: "percent", bp: 2000, reason: "Repeat guest" } });
    if (!bigger.ok) throw new Error(JSON.stringify(bigger.error));
    expect(bigger.reservation).toMatchObject({ discountAmount: 3 * RATE * 0.2 });
    expect(bigger.reservation.discount?.reason).toBe("Repeat guest");
  });
});

describe("rate settings", () => {
  it("weekend rates and seasons price new bookings; seasons may not overlap", async () => {
    expect(await updateTypeRates(db, { unitTypeId: typeId, baseRate: RATE, weekendRate: 8_000_000, minStayNights: 2, maxStayNights: 30, actor: manager })).toEqual({ ok: true });
    // 12 and 13 Feb 2027 are Friday and Saturday nights.
    const h = await hold({ checkIn: "2027-02-10", checkOut: "2027-02-14" });
    expect(h.ok && h.reservation.subtotalAmount).toBe(2 * RATE + 2 * 8_000_000);
    await updateTypeRates(db, { unitTypeId: typeId, baseRate: RATE, weekendRate: null, minStayNights: 2, maxStayNights: 30, actor: manager });

    const season = { unitTypeId: typeId, name: "Test season", startDate: "2027-07-01", endDate: "2027-09-01", nightlyRate: 8_500_000, weekendRate: null, minStayNights: 3, actor: manager };
    expect((await addSeason(db, season)).ok).toBe(true);
    expect(await addSeason(db, { ...season, startDate: "2027-08-15", endDate: "2027-09-15" })).toEqual({ ok: false, error: "overlap" });
    expect(await addSeason(db, { ...season, endDate: "2027-06-01" })).toEqual({ ok: false, error: "dates" });
  });

  it("closed-to-arrival dates refuse arrivals for one villa type or all", async () => {
    await addArrivalClosure(db, { propertyId, unitTypeId: null, startDate: "2027-03-01", endDate: "2027-03-02", note: "Nyepi", actor: manager });
    expect(await hold()).toEqual({ ok: false, error: { kind: "quote", error: { kind: "closed_to_arrival" } } });
    expect((await hold({ checkIn: "2027-02-27", checkOut: "2027-03-03" })).ok).toBe(true);
  });

  it("rejects bad offer settings", async () => {
    const off = { propertyId, nonRefundableBp: null, breakfastPerGuest: null, earlyBirdDays: null, earlyBirdBp: null, longStayTiers: [], actor: manager };
    expect(await updateOffers(db, { ...off, nonRefundableBp: 9500 })).toEqual({ ok: false, error: "invalid" });
    expect(await updateOffers(db, { ...off, earlyBirdDays: 30, earlyBirdBp: null })).toEqual({ ok: false, error: "invalid" });
    expect(await updateOffers(db, { ...off, longStayTiers: [{ minNights: 7, bp: 1000 }, { minNights: 7, bp: 1500 }] })).toEqual({ ok: false, error: "tiers" });
    expect(await updateOffers(db, { ...off, longStayTiers: [{ minNights: 14, bp: 1500 }, { minNights: 7, bp: 1000 }] })).toEqual({ ok: true });
    const [p] = await db.select().from(schema.properties).where(eq(schema.properties.id, propertyId));
    expect(p.longStayTiers).toEqual([{ minNights: 7, bp: 1000 }, { minNights: 14, bp: 1500 }]);
  });
});
