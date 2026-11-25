import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { availabilityCalendar, createHold, searchAvailability } from "@/domain/booking";
import { canTransition, changeUnitState, createBlock, readiness, resolveBlock, unitState } from "@/domain/housekeeping";
import { checkIn } from "@/domain/operations";
import { createTestDb, type TestDb } from "./test-db";

const at = (date: string) => new Date(`${date}T03:00:00Z`); // 11:00 in Bali
const staff = { type: "staff" as const, id: "hk-1" };

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
  for (const table of [schema.housekeepingEvents, schema.unitStatus, schema.unitBlocks, schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests]) {
    await db.delete(table);
  }
});

function hold(checkInDate: string, checkOutDate: string, unit: number, now: Date) {
  return createHold(db, {
    unitTypeId: typeId,
    checkIn: checkInDate,
    checkOut: checkOutDate,
    adults: 2,
    children: 0,
    guest: { fullName: "G", email: "g@example.com" },
    locale: "en",
    source: "direct",
    now,
    candidateUnitIds: [unitIds[unit]],
  });
}

describe("cleaning flow", () => {
  it("only allows cleaned -> inspected -> ready, or back to dirty", () => {
    expect(canTransition("dirty", "inspect")).toBe(true);
    expect(canTransition("dirty", "ready")).toBe(false);
    expect(canTransition("inspect", "ready")).toBe(true);
    expect(canTransition("inspect", "dirty")).toBe(true);
    expect(canTransition("ready", "dirty")).toBe(true);
    expect(canTransition("ready", "inspect")).toBe(false);
  });

  it("records every change with who and when, starting from ready", async () => {
    expect(await unitState(db, unitIds[0])).toBe("ready");
    expect(await changeUnitState(db, { unitId: unitIds[0], to: "inspect", actor: staff })).toEqual({
      ok: false,
      error: "invalid_transition",
    });
    await changeUnitState(db, { unitId: unitIds[0], to: "dirty", actor: staff, note: "Sand on floor" });
    await changeUnitState(db, { unitId: unitIds[0], to: "inspect", actor: staff });
    await changeUnitState(db, { unitId: unitIds[0], to: "ready", actor: staff });
    const events = await db.select().from(schema.housekeepingEvents).where(eq(schema.housekeepingEvents.unitId, unitIds[0])).orderBy(schema.housekeepingEvents.occurredAt);
    expect(events.map((e) => `${e.fromState}->${e.toState}`)).toEqual(["ready->dirty", "dirty->inspect", "inspect->ready"]);
    expect(events.every((e) => e.actorId === "hk-1")).toBe(true);
  });

  it("does not change the state of a villa with a guest in it", async () => {
    const h = await hold("2027-02-10", "2027-02-12", 0, at("2027-01-01"));
    if (!h.ok) throw new Error();
    await db.update(schema.reservations).set({ status: "confirmed", holdExpiresAt: null }).where(eq(schema.reservations.id, h.reservation.id));
    await checkIn(db, { reservationId: h.reservation.id, actor: staff, now: at("2027-02-10") });
    expect(await changeUnitState(db, { unitId: unitIds[0], to: "dirty", actor: staff })).toEqual({ ok: false, error: "occupied" });
  });
});

describe("readiness", () => {
  it("puts a villa with an arrival today that is not ready first", () => {
    const urgent = readiness({ state: "dirty", occupied: false, blockedToday: false, arrivalToday: true });
    const later = readiness({ state: "dirty", occupied: false, blockedToday: false, arrivalToday: false });
    const ready = readiness({ state: "ready", occupied: false, blockedToday: false, arrivalToday: true });
    expect(urgent).toEqual({ readiness: "dirty", priority: 0, needsAttention: true });
    const turnover = readiness({ state: "ready", occupied: true, blockedToday: false, arrivalToday: true, departingToday: true });
    expect(turnover).toEqual({ readiness: "occupied", priority: 1, needsAttention: true });
    expect(readiness({ state: "ready", occupied: true, blockedToday: false, arrivalToday: false, departingToday: true }).needsAttention).toBe(false);
    expect(later.priority).toBeGreaterThan(urgent.priority);
    expect(ready.priority).toBeGreaterThan(later.priority);
    expect(readiness({ state: "ready", occupied: true, blockedToday: true, arrivalToday: false }).readiness).toBe("maintenance");
  });
});

describe("maintenance blocks", () => {
  it("hides the unit from availability and holds, then returns it for inspection", async () => {
    const now = at("2027-02-01");
    expect(await createBlock(db, { unitId: unitIds[0], startDate: "2027-02-10", endDate: "2027-02-12", reason: "Pool pump", actor: staff, now })).toEqual({ ok: true });

    const search = await searchAvailability(db, { checkIn: "2027-02-11", checkOut: "2027-02-13", adults: 2, children: 0, propertySlug: "ubud", now });
    expect(search.find((r) => r.unitType.id === typeId)?.freeUnits).toBe(2);
    const days = await availabilityCalendar(db, { unitTypeId: typeId, from: "2027-02-09", days: 4, now });
    expect(days.map((d) => d.free)).toEqual([3, 2, 2, 3]);
    expect(await hold("2027-02-11", "2027-02-13", 0, now)).toEqual({ ok: false, error: { kind: "sold_out" } });

    const [block] = await db.select().from(schema.unitBlocks);
    expect(await resolveBlock(db, { blockId: block.id, actor: staff, now })).toEqual({ ok: true });
    expect(await unitState(db, unitIds[0])).toBe("inspect");
    expect(await resolveBlock(db, { blockId: block.id, actor: staff, now })).toEqual({ ok: false, error: "already_resolved" });
    expect((await hold("2027-02-11", "2027-02-13", 0, now)).ok).toBe(true);
  });

  it("refuses to block nights that a booking already uses, naming the booking", async () => {
    const h = await hold("2027-02-10", "2027-02-12", 0, at("2027-02-01"));
    if (!h.ok) throw new Error();
    const result = await createBlock(db, { unitId: unitIds[0], startDate: "2027-02-11", endDate: "2027-02-15", reason: "Paint", actor: staff, now: at("2027-02-01") });
    expect(result).toEqual({ ok: false, error: "conflicts_with_bookings", codes: [h.reservation.code] });
  });

  it("refuses overlapping open blocks, past dates and empty reasons", async () => {
    const now = at("2027-02-01");
    await createBlock(db, { unitId: unitIds[1], startDate: "2027-03-01", endDate: "2027-03-05", reason: "Roof", actor: staff, now });
    expect(await createBlock(db, { unitId: unitIds[1], startDate: "2027-03-04", endDate: "2027-03-06", reason: "Roof", actor: staff, now })).toEqual({
      ok: false,
      error: "overlaps_block",
    });
    expect(await createBlock(db, { unitId: unitIds[1], startDate: "2027-01-20", endDate: "2027-01-22", reason: "Late", actor: staff, now })).toEqual({
      ok: false,
      error: "invalid_dates",
    });
    expect(await createBlock(db, { unitId: unitIds[1], startDate: "2027-04-01", endDate: "2027-04-02", reason: "  ", actor: staff, now })).toEqual({
      ok: false,
      error: "invalid_dates",
    });
  });

  it("blocks check-in into a unit under maintenance", async () => {
    const h = await hold("2027-02-10", "2027-02-12", 2, at("2027-02-01"));
    if (!h.ok) throw new Error();
    await db.update(schema.reservations).set({ status: "confirmed", holdExpiresAt: null }).where(eq(schema.reservations.id, h.reservation.id));
    // Out-of-order today (inserted directly: createBlock would refuse because of the booking).
    await db.insert(schema.unitBlocks).values({ unitId: unitIds[2], startDate: "2027-02-10", endDate: "2027-02-11", reason: "Leak" });
    expect(await checkIn(db, { reservationId: h.reservation.id, actor: staff, now: at("2027-02-10") })).toEqual({ ok: false, error: "unit_blocked" });
  });
});
