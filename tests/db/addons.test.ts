import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { addAddonByStaff, addonUnits, cancelAddonAsGuest, checkChoice, confirmAddonOrder, createAddon, declineAddonOrder, requestAddonAsGuest } from "@/domain/addons";
import { cancelReservation, createHold, createPendingPayment, recordPaymentPaid, type HoldInput } from "@/domain/booking";
import { createTestDb, type TestDb } from "./test-db";

// 03:00 UTC = 11:00 in Bali.
const at = (date: string, utc = "03:00") => new Date(`${date}T${utc}:00Z`);
const RATE = 6_500_000;
const staff = { type: "staff" as const, id: "bm-1" };

let db: TestDb;
let close: () => Promise<void>;
let typeId: string;
let propertyId: string;
let chef: typeof schema.addons.$inferSelect;
let transfer: typeof schema.addons.$inferSelect;
let lunch: typeof schema.addons.$inferSelect;

beforeAll(async () => {
  const test = await createTestDb();
  db = test.db;
  close = () => test.client.close();
  await seedSampleData(db);
  const [type] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.slug, "river-pavilion"));
  typeId = type.id;
  propertyId = type.propertyId;
  const make = async (name: string, pricing: string, price: number, needsTime: boolean, category: string) => {
    const r = await createAddon(db, { propertyId, name: { id: name, en: name }, description: null, category, pricing, price, needsTime, leadHours: 24, sortOrder: 0, actor: staff });
    if (!r.ok) throw new Error("addon");
    return (await db.select().from(schema.addons).where(eq(schema.addons.id, r.id)))[0];
  };
  chef = await make("Private chef dinner", "per_person", 450_000, true, "food_beverage");
  transfer = await make("Airport transfer", "per_booking", 350_000, true, "transfer");
  lunch = await make("Daily lunch", "per_person_night", 150_000, false, "food_beverage");
});
afterAll(async () => close());
beforeEach(async () => {
  for (const table of [schema.addonOrders, schema.tasks, schema.folioCharges, schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests]) await db.delete(table);
});

const stay = { checkIn: "2027-02-10", checkOut: "2027-02-13", adults: 2, children: 1 };

describe("pricing and checks", () => {
  it("counts units by pricing and checks date, time, counts and notice", () => {
    expect(addonUnits("per_booking", { persons: 3, nights: 3, quantity: 2 })).toBe(2);
    expect(addonUnits("per_person", { persons: 3, nights: 3, quantity: 2 })).toBe(3);
    expect(addonUnits("per_night", { persons: 3, nights: 3, quantity: 2 })).toBe(3);
    expect(addonUnits("per_person_night", { persons: 3, nights: 3, quantity: 2 })).toBe(9);
    const opts = { timezone: "Asia/Makassar", now: at("2027-02-01") };
    expect(checkChoice(chef, { addonId: chef.id, serviceDate: "2027-02-11", serviceTime: "19:00" }, stay, opts)).toMatchObject({ ok: true, value: { persons: 3, units: 3, amount: 1_350_000 } });
    expect(checkChoice(lunch, { addonId: lunch.id, serviceDate: "2027-02-10", persons: 2 }, stay, opts)).toMatchObject({ ok: true, value: { units: 6, amount: 900_000 } });
    expect(checkChoice(chef, { addonId: chef.id, serviceDate: "2027-02-14", serviceTime: "19:00" }, stay, opts)).toEqual({ ok: false, error: "invalid_date" });
    expect(checkChoice(chef, { addonId: chef.id, serviceDate: "2027-02-11" }, stay, opts)).toEqual({ ok: false, error: "invalid_time" });
    expect(checkChoice(chef, { addonId: chef.id, serviceDate: "2027-02-11", serviceTime: "19:00", persons: 4 }, stay, opts)).toEqual({ ok: false, error: "invalid_count" });
    // 24 hours' notice: 10 Feb 15:00 local is too close for 11 Feb 08:00.
    expect(checkChoice(transfer, { addonId: transfer.id, serviceDate: "2027-02-11", serviceTime: "08:00" }, stay, { timezone: "Asia/Makassar", now: at("2027-02-10", "07:00") })).toEqual({ ok: false, error: "too_late" });
    expect(checkChoice(transfer, { addonId: transfer.id, serviceDate: "2027-02-11", serviceTime: "08:00" }, stay, { timezone: "Asia/Makassar", now: at("2027-02-10", "07:00"), skipLeadTime: true }).ok).toBe(true);
  });
});

async function hold(addons: HoldInput["addons"], now = at("2027-02-01")) {
  const h = await createHold(db, { unitTypeId: typeId, ...stay, children: 0, guest: { fullName: "Guest", email: "g@example.com", phone: "0811 2345 6789" }, locale: "en", source: "website", now, addons });
  if (!h.ok) throw new Error(JSON.stringify(h.error));
  return h.reservation;
}
async function payAll(r: typeof schema.reservations.$inferSelect, amount = r.depositAmount) {
  await createPendingPayment(db, { reservationId: r.id, provider: "simulated", providerRef: `a-${r.code}`, purpose: "full", amount, checkoutUrl: null, expiresAt: null });
  await recordPaymentPaid(db, { provider: "simulated", providerRef: `a-${r.code}`, amount, paidAt: at("2027-02-01") });
}

describe("orders", () => {
  it("checkout add-ons join the total and the deposit; staff confirm one (a task) and decline the other (refund owed)", async () => {
    const r = await hold([
      { addonId: chef.id, serviceDate: "2027-02-11", serviceTime: "19:00", persons: 2 },
      { addonId: transfer.id, serviceDate: "2027-02-10", serviceTime: "10:00", quantity: 1 },
    ]);
    const extras = 900_000 + 350_000;
    // Paid in full: arrival is within the balance period.
    expect(r).toMatchObject({ extrasAmount: extras, totalAmount: 3 * RATE + extras, depositAmount: 3 * RATE + extras });
    const orders = await db.select().from(schema.addonOrders).where(eq(schema.addonOrders.reservationId, r.id));
    expect(orders.map((o) => [o.source, o.status, o.amount, Boolean(o.folioChargeId)])).toEqual(expect.arrayContaining([["checkout", "requested", 900_000, true], ["checkout", "requested", 350_000, true]]));
    expect(await db.select().from(schema.folioCharges).where(eq(schema.folioCharges.reservationId, r.id))).toHaveLength(2);
    await payAll(r);

    const chefOrder = orders.find((o) => o.addonId === chef.id)!;
    const transferOrder = orders.find((o) => o.addonId === transfer.id)!;
    expect(await confirmAddonOrder(db, { orderId: chefOrder.id, actor: staff, now: at("2027-02-02") })).toEqual({ ok: true });
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.reservationId, r.id));
    expect(task).toMatchObject({ kind: "request", source: `addon:${chefOrder.id}`, dueDate: "2027-02-11", dueTime: "19:00:00", status: "open" });
    expect(await confirmAddonOrder(db, { orderId: chefOrder.id, actor: staff })).toEqual({ ok: false, error: "already_decided" });

    expect(await declineAddonOrder(db, { orderId: transferOrder.id, reason: "", actor: staff })).toEqual({ ok: false, error: "reason_required" });
    expect(await declineAddonOrder(db, { orderId: transferOrder.id, reason: "No driver that morning", actor: staff, now: at("2027-02-02") })).toEqual({ ok: true });
    const [after] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, r.id));
    expect(after).toMatchObject({ totalAmount: 3 * RATE + 900_000, refundAmount: 350_000 });
    const messages = (await db.select().from(schema.notificationOutbox)).filter((m) => m.kind === "addon_decided");
    expect(messages.map((m) => [m.channel, (m.payload as { approved: boolean }).approved]).sort()).toEqual([["email", false], ["email", true], ["whatsapp", false], ["whatsapp", true]]);
  });

  it("portal requests are charged only once confirmed; staff orders are confirmed at once; cancelling the booking cancels orders", async () => {
    const r = await hold(undefined, at("2027-01-05"));
    await payAll(r);
    const asked = await requestAddonAsGuest(db, { reservationId: r.id, choice: { addonId: lunch.id, serviceDate: "2027-02-10", persons: 2, nights: 2 }, now: at("2027-01-06") });
    if (!asked.ok) throw new Error(asked.error);
    let [res] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, r.id));
    expect(res.extrasAmount).toBe(0);
    const withdrawn = await requestAddonAsGuest(db, { reservationId: r.id, choice: { addonId: chef.id, serviceDate: "2027-02-12", serviceTime: "19:00" }, now: at("2027-01-06") });
    expect(withdrawn.ok && (await cancelAddonAsGuest(db, { reservationId: r.id, orderId: withdrawn.orderId }))).toEqual({ ok: true });

    expect(await confirmAddonOrder(db, { orderId: asked.orderId, actor: staff, now: at("2027-01-07") })).toEqual({ ok: true });
    [res] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, r.id));
    expect(res).toMatchObject({ extrasAmount: 600_000, totalAmount: 3 * RATE + 600_000 });

    const added = await addAddonByStaff(db, { reservationId: r.id, choice: { addonId: transfer.id, serviceDate: "2027-02-13", serviceTime: "09:00" }, actor: staff, now: at("2027-02-12", "23:00") });
    expect(added.ok).toBe(true);
    const orders = await db.select().from(schema.addonOrders).where(eq(schema.addonOrders.reservationId, r.id));
    expect(orders.map((o) => [o.source, o.status]).sort()).toEqual([["portal", "cancelled"], ["portal", "confirmed"], ["staff", "confirmed"]]);

    await cancelReservation(db, { reservationId: r.id, actor: staff, now: at("2027-01-20") });
    const after = await db.select().from(schema.addonOrders).where(eq(schema.addonOrders.reservationId, r.id));
    expect(after.every((o) => o.status === "cancelled")).toBe(true);
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.reservationId, r.id))).every((t) => t.status === "cancelled")).toBe(true);
  });
});
