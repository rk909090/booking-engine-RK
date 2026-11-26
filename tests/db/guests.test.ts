import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { cancelReservation, createHold, createPendingPayment, recordPaymentPaid } from "@/domain/booking";
import { anonymizeGuest, exportGuestData, foreignArrivals, guestStats, markApoaReported, mergeGuests, normalizePhone, updateGuest } from "@/domain/guests";
import { checkIn, checkOut } from "@/domain/operations";
import { savePreCheckin } from "@/domain/pre-checkin";
import { createTestDb, type TestDb } from "./test-db";

const at = (date: string) => new Date(`${date}T03:00:00Z`);
const RATE = 6_500_000;
const staff = { type: "staff" as const, id: "bm-1" };

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
  for (const table of [schema.tasks, schema.preCheckinGuests, schema.preCheckins, schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests]) await db.delete(table);
});

async function book(guest: { fullName: string; email?: string | null; phone?: string | null; countryCode?: string | null }, unit: number, checkInDate: string, checkOutDate: string, source: "website" | "direct" = "direct") {
  const h = await createHold(db, { unitTypeId: typeId, checkIn: checkInDate, checkOut: checkOutDate, adults: 2, children: 0, guest, locale: "en", source, now: at("2027-01-05"), candidateUnitIds: [unitIds[unit]] });
  if (!h.ok) throw new Error(JSON.stringify(h.error));
  await createPendingPayment(db, { reservationId: h.reservation.id, provider: "simulated", providerRef: `g-${h.reservation.code}`, purpose: "full", amount: h.reservation.totalAmount, checkoutUrl: null, expiresAt: null });
  await recordPaymentPaid(db, { provider: "simulated", providerRef: `g-${h.reservation.code}`, amount: h.reservation.totalAmount, paidAt: at("2027-01-05") });
  return h.reservation;
}

describe("recognising returning guests", () => {
  it("joins bookings by email, or by phone when the profile has no other email", async () => {
    expect(normalizePhone("0811-2345-6789")).toBe("6281123456789");
    expect(normalizePhone("+62 811 2345 6789")).toBe("6281123456789");
    expect(normalizePhone("123")).toBeNull();

    const a = await book({ fullName: "Ana Smith", email: "Ana@Example.com", phone: "0811 2345 6789" }, 0, "2027-02-01", "2027-02-03");
    const b = await book({ fullName: "Ana S.", email: "ana@example.com" }, 0, "2027-02-10", "2027-02-12");
    expect(b.guestId).toBe(a.guestId);
    // Same phone, no email: a walk-in by the same person.
    const c = await book({ fullName: "Ana", phone: "+62 811-2345-6789" }, 1, "2027-02-10", "2027-02-12");
    expect(c.guestId).toBe(a.guestId);
    // Same phone but another email: an agent booking someone else.
    const d = await book({ fullName: "Ben Jones", email: "ben@example.com", phone: "08112345 6789" }, 2, "2027-02-10", "2027-02-12");
    expect(d.guestId).not.toBe(a.guestId);
    const [profile] = await db.select().from(schema.guests).where(eq(schema.guests.id, a.guestId));
    expect(profile).toMatchObject({ fullName: "Ana Smith", email: "ana@example.com", phoneNormalized: "6281123456789" });
  });

  it("counts stays, nights and spend", async () => {
    const r = await book({ fullName: "Cleo", email: "cleo@example.com" }, 0, "2027-02-01", "2027-02-04");
    await book({ fullName: "Cleo", email: "cleo@example.com" }, 0, "2027-03-01", "2027-03-03");
    await checkIn(db, { reservationId: r.id, actor: staff, now: at("2027-02-01") });
    await checkOut(db, { reservationId: r.id, actor: staff, now: at("2027-02-04") });
    const stats = (await guestStats(db, [r.guestId])).get(r.guestId);
    expect(stats).toEqual({ stays: 1, nights: 3, spend: 3 * RATE, upcoming: 1, lastStay: "2027-02-04" });
  });
});

describe("profiles", () => {
  it("keeps notes and tags, points to a duplicate, and merges it", async () => {
    const a = await book({ fullName: "Dewi", email: "dewi@example.com" }, 0, "2027-02-01", "2027-02-03");
    const b = await book({ fullName: "Dewi", phone: "0812 9999 0000" }, 1, "2027-02-05", "2027-02-07");
    expect(a.guestId).not.toBe(b.guestId);
    const base = { guestId: a.guestId, fullName: "Dewi Lestari", email: "dewi@example.com", phone: null, countryCode: "ID", notes: "Allergic to nuts", tags: ["vip"], actor: staff };
    expect(await updateGuest(db, { ...base, tags: ["gold"] })).toEqual({ ok: false, error: "invalid" });
    expect(await updateGuest(db, { ...base, phone: "0812-9999-0000" })).toEqual({ ok: false, error: "duplicate", otherId: b.guestId });
    expect(await updateGuest(db, base)).toEqual({ ok: true });

    await db.update(schema.guests).set({ tags: ["honeymoon"] }).where(eq(schema.guests.id, b.guestId));
    expect(await mergeGuests(db, { keepId: a.guestId, removeId: b.guestId, actor: staff })).toEqual({ ok: true });
    const moved = await db.select().from(schema.reservations).where(eq(schema.reservations.guestId, a.guestId));
    expect(moved).toHaveLength(2);
    const [kept] = await db.select().from(schema.guests).where(eq(schema.guests.id, a.guestId));
    expect(kept).toMatchObject({ phone: "0812 9999 0000", tags: ["vip", "honeymoon"], notes: "Allergic to nuts" });
    expect(await db.select().from(schema.guests).where(eq(schema.guests.id, b.guestId))).toEqual([]);
  });
});

describe("UU PDP requests", () => {
  it("exports what is held, and erases personal data once no booking is active, keeping the money", async () => {
    const r = await book({ fullName: "Eve Taylor", email: "eve@example.com", phone: "+61 412 345 678" }, 0, "2027-02-10", "2027-02-12");
    await savePreCheckin(db, {
      reservationId: r.id, arrivalTime: "15:00", flightNumber: "QF43", landingDate: "2027-02-10", landingTime: "11:00", transferRequested: true, transferNote: "2 bags", requests: "Late dinner", acceptRules: true,
      guests: [0, 1].map((i) => ({ fullName: `Guest ${i}`, nationality: "AU", birthDate: "1990-01-01", documentType: "passport", documentNumber: `PA12345${i}` })), now: at("2027-02-01"),
    }, (s) => `sealed:${s}`);
    const data = await exportGuestData(db, { guestId: r.guestId, actor: staff });
    expect(data?.profile.email).toBe("eve@example.com");
    expect(data?.bookings[0].preCheckin?.guests[0]).toMatchObject({ fullName: "Guest 0", documentLast4: "3450" });
    expect(JSON.stringify(data)).not.toContain("sealed:");

    expect(await anonymizeGuest(db, { guestId: r.guestId, actor: staff })).toEqual({ ok: false, error: "active_booking" });
    await cancelReservation(db, { reservationId: r.id, actor: staff, now: at("2027-01-20") });
    expect(await anonymizeGuest(db, { guestId: r.guestId, actor: staff })).toEqual({ ok: true });
    const [g] = await db.select().from(schema.guests).where(eq(schema.guests.id, r.guestId));
    expect(g).toMatchObject({ fullName: "—", email: null, phone: null, notes: null });
    expect(g.anonymizedAt).toBeTruthy();
    const [kept] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, r.id));
    expect(kept).toMatchObject({ totalAmount: 2 * RATE, amountPaid: 2 * RATE, specialRequests: null });
    expect(await db.select().from(schema.preCheckins)).toEqual([]);
    expect(await db.select().from(schema.notificationOutbox)).toEqual([]);
    expect(await anonymizeGuest(db, { guestId: r.guestId, actor: staff })).toEqual({ ok: false, error: "anonymized" });
  });
});

describe("immigration report (APOA)", () => {
  it("lists foreign adults from pre-check-in and foreign bookings still missing it, then marks them reported", async () => {
    const mixed = await book({ fullName: "Frank", email: "frank@example.com" }, 0, "2027-02-10", "2027-02-12");
    await savePreCheckin(db, {
      reservationId: mixed.id, arrivalTime: "", flightNumber: "", landingDate: "", landingTime: "", transferRequested: false, transferNote: "", requests: "", acceptRules: true,
      guests: [
        { fullName: "Frank Müller", nationality: "DE", birthDate: "1980-05-05", documentType: "passport", documentNumber: "C01X00T47" },
        { fullName: "Sari Dewi", nationality: "ID", birthDate: "1985-06-06", documentType: "id_card", documentNumber: "5171000000000001" },
      ],
      now: at("2027-02-01"),
    }, (s) => `sealed:${s}`);
    const missing = await book({ fullName: "Marie", email: "marie@example.com", countryCode: "FR" }, 1, "2027-02-11", "2027-02-13");
    await book({ fullName: "Budi", email: "budi@example.com", countryCode: "ID" }, 2, "2027-02-11", "2027-02-13");

    const list = await foreignArrivals(db, { propertyId, from: "2027-02-10", to: "2027-02-11" });
    expect(list.map((x) => [x.code, x.missing, x.guests.map((g) => g.nationality)])).toEqual([
      [mixed.code, false, ["DE"]],
      [missing.code, true, []],
    ]);
    expect(await markApoaReported(db, { reservationIds: [mixed.id], reported: true, actor: staff })).toBe(1);
    expect(await markApoaReported(db, { reservationIds: [mixed.id], reported: true, actor: staff })).toBe(0);
    const after = await foreignArrivals(db, { propertyId, from: "2027-02-10", to: "2027-02-10" });
    expect(after[0].reportedAt).toBeTruthy();
  });
});
