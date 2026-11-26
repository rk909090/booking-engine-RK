import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { createHold, createPendingPayment, recordPaymentPaid } from "@/domain/booking";
import { addCharge, addParty, invoiceData, issueInvoice, partyBalances, receiptData, recordPartyPayment, voidCharge } from "@/domain/folio";
import { decideLateCheckout, requestLateCheckout } from "@/domain/late-checkout";
import { recordManualPayment } from "@/domain/operations";
import { balanceDue } from "@/domain/pricing";
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
  for (const table of [schema.invoices, schema.invoiceCounters, schema.lateCheckoutRequests, schema.notificationOutbox, schema.payments, schema.folioCharges, schema.folioParties, schema.auditEvents, schema.reservations, schema.guests]) {
    await db.delete(table);
  }
});

async function booking(unit = 0, opts: { pay?: "full" | "none" } = {}) {
  const h = await createHold(db, {
    unitTypeId: typeId, checkIn: "2027-02-10", checkOut: "2027-02-12", adults: 2, children: 0,
    guest: { fullName: "Ana Smith", email: "ana@example.com" }, locale: "en", source: "website", now: at("2027-01-01"), candidateUnitIds: [unitIds[unit]],
  });
  if (!h.ok) throw new Error(JSON.stringify(h.error));
  if (opts.pay !== "none") {
    await createPendingPayment(db, { reservationId: h.reservation.id, provider: "simulated", providerRef: `r-${h.reservation.code}`, purpose: "full", amount: h.reservation.totalAmount, checkoutUrl: null, expiresAt: null });
    await recordPaymentPaid(db, { provider: "simulated", providerRef: `r-${h.reservation.code}`, amount: h.reservation.totalAmount, paidAt: at("2027-01-01") });
  }
  return h.reservation;
}
const reload = async (id: string) => (await db.select().from(schema.reservations).where(eq(schema.reservations.id, id)))[0];
const charge = (reservationId: string, over: Partial<Parameters<typeof addCharge>[1]> = {}) =>
  addCharge(db, { reservationId, category: "spa", description: "Balinese massage", quantity: 2, unitPrice: 450_000, actor: staff, now, ...over });

describe("folio charges", () => {
  it("adds guest charges to the booking total and keeps other parties' charges off it", async () => {
    const r = await booking();
    expect(await charge(r.id)).toMatchObject({ ok: true, amount: 900_000 });
    let after = await reload(r.id);
    expect(after).toMatchObject({ extrasAmount: 900_000, totalAmount: 2 * RATE + 900_000 });
    expect(balanceDue(after)).toBe(900_000);

    const party = await addParty(db, { reservationId: r.id, name: "PT Contoh Wisata", details: "NPWP 01.234.567.8-901.000", actor: staff, now });
    if (!party.ok) throw new Error();
    expect(await charge(r.id, { category: "transfer", description: "Airport pick-up", quantity: 1, unitPrice: 350_000, partyId: party.partyId })).toMatchObject({ ok: true });
    after = await reload(r.id);
    expect(after.totalAmount).toBe(2 * RATE + 900_000);
    expect(await partyBalances(db, r.id)).toMatchObject([{ name: "PT Contoh Wisata", total: 350_000, paid: 0, balance: 350_000 }]);
  });

  it("checks the charge, and only allows it on confirmed, in-house or checked-out bookings", async () => {
    const r = await booking();
    expect(await charge(r.id, { category: "casino" })).toEqual({ ok: false, error: "invalid_category" });
    expect(await charge(r.id, { description: "  " })).toEqual({ ok: false, error: "invalid_description" });
    expect(await charge(r.id, { quantity: 0 })).toEqual({ ok: false, error: "invalid_quantity" });
    expect(await charge(r.id, { unitPrice: -1 })).toEqual({ ok: false, error: "invalid_price" });
    expect(await charge(r.id, { partyId: "00000000-0000-0000-0000-000000000000" })).toEqual({ ok: false, error: "invalid_party" });
    const hold = await booking(1, { pay: "none" });
    expect(await charge(hold.id)).toEqual({ ok: false, error: "not_allowed" });
  });

  it("voids a charge with a reason; a paid guest charge leaves a refund owed", async () => {
    const r = await booking();
    const c = await charge(r.id);
    if (!c.ok) throw new Error();
    await recordManualPayment(db, { reservationId: r.id, amount: 900_000, method: "cash", actor: staff, now });
    expect(await voidCharge(db, { reservationId: r.id, chargeId: c.chargeId, reason: " ", actor: staff, now })).toEqual({ ok: false, error: "reason_required" });
    expect(await voidCharge(db, { reservationId: r.id, chargeId: c.chargeId, reason: "Charged to wrong villa", actor: staff, now })).toEqual({ ok: true });
    expect(await voidCharge(db, { reservationId: r.id, chargeId: c.chargeId, reason: "again", actor: staff, now })).toEqual({ ok: false, error: "already_void" });
    const after = await reload(r.id);
    expect(after).toMatchObject({ extrasAmount: 0, totalAmount: 2 * RATE, refundAmount: 900_000 });
    const [row] = await db.select().from(schema.folioCharges).where(eq(schema.folioCharges.id, c.chargeId));
    expect(row).toMatchObject({ status: "void", voidReason: "Charged to wrong villa", voidedBy: "fo-1" });
  });

  it("records a party's payments apart from the guest's, up to what they owe", async () => {
    const r = await booking();
    const party = await addParty(db, { reservationId: r.id, name: "Agent Co", actor: staff, now });
    if (!party.ok) throw new Error();
    await charge(r.id, { partyId: party.partyId, quantity: 1, unitPrice: 500_000 });
    expect(await recordPartyPayment(db, { reservationId: r.id, partyId: party.partyId, amount: 600_000, method: "bank_transfer", actor: staff, now })).toEqual({ ok: false, error: "invalid_amount" });
    expect(await recordPartyPayment(db, { reservationId: r.id, partyId: party.partyId, amount: 500_000, method: "bank_transfer", reference: "BCA 77", actor: staff, now })).toEqual({ ok: true });
    expect(await partyBalances(db, r.id)).toMatchObject([{ total: 500_000, paid: 500_000, balance: 0 }]);
    expect((await reload(r.id)).amountPaid).toBe(2 * RATE);
  });
});

describe("invoices and receipts", () => {
  it("numbers invoices once per bill, in order per property and year", async () => {
    const a = await booking(0);
    const b = await booking(1);
    expect(await issueInvoice(db, { reservationId: a.id, actor: staff, now })).toEqual({ ok: true, number: "INV-UBUD-2027-00001" });
    expect(await issueInvoice(db, { reservationId: a.id, actor: staff, now })).toEqual({ ok: true, number: "INV-UBUD-2027-00001" });
    expect(await issueInvoice(db, { reservationId: b.id, actor: staff, now })).toEqual({ ok: true, number: "INV-UBUD-2027-00002" });
    const party = await addParty(db, { reservationId: a.id, name: "Agent Co", actor: staff, now });
    if (!party.ok) throw new Error();
    expect(await issueInvoice(db, { reservationId: a.id, partyId: party.partyId, actor: staff, now })).toEqual({ ok: true, number: "INV-UBUD-2027-00003" });
    expect(await issueInvoice(db, { reservationId: b.id, actor: staff, now: at("2028-01-03") })).toEqual({ ok: true, number: "INV-UBUD-2027-00002" });
  });

  it("lists the guest's bill so the lines add up to the total, with payments and the balance", async () => {
    const r = await booking();
    await requestLateCheckout(db, { reservationId: r.id, time: "15:00", actor: staff, now });
    await decideLateCheckout(db, { reservationId: r.id, approve: true, fee: 250_000, actor: staff, now });
    await charge(r.id, { category: "minibar", description: "Soft drinks", quantity: 3, unitPrice: 25_000 });
    const party = await addParty(db, { reservationId: r.id, name: "Agent Co", actor: staff, now });
    if (!party.ok) throw new Error();
    await charge(r.id, { partyId: party.partyId, quantity: 1, unitPrice: 500_000 });

    const guest = await invoiceData(db, { reservationId: r.id });
    expect(guest?.lines.map((l) => [l.kind, l.amount])).toEqual([
      ["nights", 2 * RATE],
      ["late", 250_000],
      ["charge", 75_000],
    ]);
    expect(guest).toMatchObject({ total: 2 * RATE + 325_000, paid: 2 * RATE, balance: 325_000 });
    expect(guest?.lines.reduce((s, l) => s + l.amount, 0)).toBe(guest?.total);

    const theirs = await invoiceData(db, { reservationId: r.id, partyId: party.partyId });
    expect(theirs).toMatchObject({ total: 500_000, paid: 0, balance: 500_000, party: { name: "Agent Co" } });
    expect(theirs?.lines.map((l) => l.label)).toEqual(["Balinese massage"]);
  });

  it("numbers receipts by payment order within the booking", async () => {
    const r = await booking();
    await charge(r.id);
    await recordManualPayment(db, { reservationId: r.id, amount: 900_000, method: "cash", actor: staff, now });
    const payments = await db.select().from(schema.payments).where(eq(schema.payments.reservationId, r.id)).orderBy(schema.payments.paidAt);
    const second = await receiptData(db, { reservationId: r.id, paymentId: payments[1].id });
    expect(second).toMatchObject({ number: `${r.code}-2`, payment: { amount: 900_000 } });
    expect(await receiptData(db, { reservationId: r.id, paymentId: "00000000-0000-0000-0000-000000000000" })).toBeNull();
  });
});
