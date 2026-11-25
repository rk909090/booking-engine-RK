import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { cancelReservation, createHold, createPendingPayment, recordPaymentPaid } from "@/domain/booking";
import { eraseExpiredDocuments, preCheckinView, revealDocuments, savePreCheckin, type PreCheckinInput } from "@/domain/pre-checkin";
import { openGuestData, sealGuestData } from "@/lib/crypto/guest-data";
import { createTestDb, type TestDb } from "./test-db";

process.env.BETTER_AUTH_SECRET ||= "test-only-secret-for-guest-data-encryption";
const at = (date: string) => new Date(`${date}T03:00:00Z`);
const now = at("2027-02-01");
const staff = { type: "staff" as const, id: "fo-1" };

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
  for (const table of [schema.preCheckinGuests, schema.preCheckins, schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests]) {
    await db.delete(table);
  }
});

async function booking(unit = 0) {
  const h = await createHold(db, {
    unitTypeId: typeId, checkIn: "2027-02-10", checkOut: "2027-02-12", adults: 2, children: 0,
    guest: { fullName: "Lead", email: "lead@example.com" }, locale: "en", source: "website", now: at("2027-01-05"), candidateUnitIds: [unitIds[unit]],
  });
  if (!h.ok) throw new Error(JSON.stringify(h.error));
  await createPendingPayment(db, { reservationId: h.reservation.id, provider: "simulated", providerRef: `r-${h.reservation.code}`, purpose: "full", amount: h.reservation.totalAmount, checkoutUrl: null, expiresAt: null });
  await recordPaymentPaid(db, { provider: "simulated", providerRef: `r-${h.reservation.code}`, amount: h.reservation.totalAmount, paidAt: at("2027-01-05") });
  return h.reservation;
}

const form = (reservationId: string, over: Partial<PreCheckinInput> = {}): PreCheckinInput => ({
  reservationId,
  arrivalTime: "16:30",
  flightNumber: "ga 404",
  landingDate: "2027-02-10",
  landingTime: "13:05",
  transferRequested: true,
  transferNote: "3 suitcases",
  requests: "Baby cot please",
  acceptRules: true,
  guests: [
    { fullName: "  Ana   Smith ", nationality: "au", birthDate: "1990-04-02", documentType: "passport", documentNumber: "pa 123-4567" },
    { fullName: "Budi Santoso", nationality: "ID", birthDate: "1988-11-30", documentType: "id_card", documentNumber: "5171012345670001" },
  ],
  now,
  ...over,
});

describe("online pre-check-in", () => {
  it("saves the arrival, the guests and encrypted document numbers, without personal data in the log", async () => {
    const r = await booking();
    expect(await savePreCheckin(db, form(r.id), sealGuestData)).toEqual({ ok: true, updated: false });

    const view = await preCheckinView(db, r.id);
    expect(view).toMatchObject({ flightNumber: "GA404", landingTime: "13:05:00", transferRequested: true, requests: "Baby cot please" });
    expect(view?.guests).toMatchObject([
      { position: 0, fullName: "Ana Smith", nationality: "AU", documentType: "passport", documentLast4: "4567", hasDocument: true },
      { position: 1, fullName: "Budi Santoso", nationality: "ID", documentType: "id_card", documentLast4: "0001" },
    ]);
    const stored = await db.select().from(schema.preCheckinGuests);
    expect(stored.every((g) => g.documentNumberEnc?.startsWith("v1.a.") && !g.documentNumberEnc.includes("PA1234567"))).toBe(true);
    const [res] = await db.select().from(schema.reservations).where(eq(schema.reservations.id, r.id));
    expect(res.estimatedArrival).toBe("16:30:00");

    const [event] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "pre_checkin.submitted"));
    expect(event).toMatchObject({ actorType: "guest", after: { guests: 2, transfer: true, arrival: "16:30", flight: true } });
    expect(JSON.stringify(event.after)).not.toMatch(/Ana|Budi|4567|0001/);
  });

  it("checks every field and the number of adults, and closes after the arrival day or once cancelled", async () => {
    const r = await booking();
    expect(await savePreCheckin(db, form(r.id, { acceptRules: false }), sealGuestData)).toEqual({ ok: false, error: { kind: "rules_required" } });
    expect(await savePreCheckin(db, form(r.id, { guests: form(r.id).guests.slice(0, 1) }), sealGuestData)).toEqual({ ok: false, error: { kind: "guest_count", expected: 2 } });
    const bad = (i: number, patch: object) => form(r.id, { guests: form(r.id).guests.map((g, j) => (j === i ? { ...g, ...patch } : g)) });
    expect(await savePreCheckin(db, bad(1, { documentNumber: "12" }), sealGuestData)).toEqual({ ok: false, error: { kind: "guest", index: 1, field: "documentNumber" } });
    expect(await savePreCheckin(db, bad(0, { birthDate: "2030-01-01" }), sealGuestData)).toEqual({ ok: false, error: { kind: "guest", index: 0, field: "birthDate" } });
    expect(await savePreCheckin(db, bad(0, { documentType: "visa" }), sealGuestData)).toEqual({ ok: false, error: { kind: "guest", index: 0, field: "documentType" } });
    expect(await savePreCheckin(db, form(r.id, { landingDate: "2027-02-01" }), sealGuestData)).toEqual({ ok: false, error: { kind: "flight" } });
    expect(await savePreCheckin(db, form(r.id, { arrivalTime: "25:00" }), sealGuestData)).toEqual({ ok: false, error: { kind: "arrival_time" } });
    expect(await savePreCheckin(db, form(r.id, { now: at("2027-02-11") }), sealGuestData)).toEqual({ ok: false, error: { kind: "closed" } });
    // The arrival day itself is still open.
    expect((await savePreCheckin(db, form(r.id, { now: at("2027-02-10") }), sealGuestData)).ok).toBe(true);
    await cancelReservation(db, { reservationId: r.id, actor: { type: "guest" }, now });
    expect(await savePreCheckin(db, form(r.id), sealGuestData)).toEqual({ ok: false, error: { kind: "closed" } });
  });

  it("keeps a saved document number when the field is left empty, and replaces it when a new one is typed", async () => {
    const r = await booking();
    await savePreCheckin(db, form(r.id), sealGuestData);
    const guests = form(r.id).guests.map((g, i) => ({ ...g, documentNumber: i === 1 ? "X9876543" : "" }));
    expect(await savePreCheckin(db, form(r.id, { guests, transferRequested: false }), sealGuestData)).toEqual({ ok: true, updated: true });
    const shown = await revealDocuments(db, { reservationId: r.id, actor: staff, now }, openGuestData);
    expect(shown).toEqual([
      { position: 0, documentNumber: "PA1234567" },
      { position: 1, documentNumber: "X9876543" },
    ]);
    expect((await preCheckinView(db, r.id))?.transferRequested).toBe(false);
    const [event] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "pre_checkin.documents_viewed"));
    expect(event).toMatchObject({ actorType: "staff", actorId: "fo-1", after: { guests: 2 } });
  });

  it("erases document numbers 30 days after check-out, and right away for a cancelled booking", async () => {
    const stay = await booking(0);
    const cancelled = await booking(1);
    await savePreCheckin(db, form(stay.id), sealGuestData);
    await savePreCheckin(db, form(cancelled.id), sealGuestData);
    await cancelReservation(db, { reservationId: cancelled.id, actor: { type: "guest" }, now });

    expect(await eraseExpiredDocuments(db, "2027-02-05", now)).toBe(2);
    expect((await preCheckinView(db, cancelled.id))?.guests[0]).toMatchObject({ hasDocument: false, documentErased: true, documentLast4: null });
    expect(await eraseExpiredDocuments(db, "2027-03-14", now)).toBe(0); // check-out 12 Feb + 30 days = 14 Mar
    expect(await eraseExpiredDocuments(db, "2027-03-15", now)).toBe(2);
    expect((await preCheckinView(db, stay.id))?.guests.map((g) => g.documentErased)).toEqual([true, true]);
    // Names and nationality stay as the registration record.
    expect((await preCheckinView(db, stay.id))?.guests[0]).toMatchObject({ fullName: "Ana Smith", nationality: "AU" });
  });
});

describe("guest data encryption", () => {
  it("round-trips, rejects tampering, and keeps old values readable after GUEST_DATA_KEY is set", () => {
    const sealed = sealGuestData("PA1234567");
    expect(openGuestData(sealed)).toBe("PA1234567");
    expect(sealGuestData("PA1234567")).not.toBe(sealed); // fresh IV each time
    const parts = sealed.split(".");
    parts[4] = Buffer.from("tampered").toString("base64url");
    expect(openGuestData(parts.join("."))).toBeNull();
    expect(openGuestData("plain-text")).toBeNull();

    process.env.GUEST_DATA_KEY = randomBytes(32).toString("base64");
    try {
      const withKey = sealGuestData("B7654321");
      expect(withKey.startsWith("v1.g.")).toBe(true);
      expect(openGuestData(withKey)).toBe("B7654321");
      expect(openGuestData(sealed)).toBe("PA1234567");
    } finally {
      delete process.env.GUEST_DATA_KEY;
    }
  });
});
