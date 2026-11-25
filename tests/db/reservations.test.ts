import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { createTestDb, type TestDb } from "./test-db";

/** Postgres SQLSTATE codes we assert on. */
const EXCLUSION_VIOLATION = "23P01";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

/** Drizzle wraps driver errors; walk the cause chain to the SQLSTATE. */
function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  while (current && typeof current === "object") {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

async function expectSqlState(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(sqlState(error)).toBe(code);
}

let db: TestDb;
let close: () => Promise<void>;
let unitA: typeof schema.units.$inferSelect;
let unitB: typeof schema.units.$inferSelect;
let otherTypeUnit: typeof schema.units.$inferSelect;
let guestId: string;
let counter = 0;

type StayInput = {
  unit?: typeof schema.units.$inferSelect;
  checkIn: string;
  checkOut: string;
  status?: (typeof schema.reservationStatus.enumValues)[number];
  holdExpiresAt?: Date | null;
  unitTypeId?: string;
};

function book({ unit = unitA, checkIn, checkOut, status = "confirmed", holdExpiresAt, unitTypeId }: StayInput) {
  counter += 1;
  return db
    .insert(schema.reservations)
    .values({
      code: `T-${counter}`,
      propertyId: unit.propertyId,
      unitTypeId: unitTypeId ?? unit.unitTypeId,
      unitId: unit.id,
      guestId,
      status,
      source: "direct",
      checkIn,
      checkOut,
      adults: 2,
      totalAmount: 1_000_000,
      holdExpiresAt: holdExpiresAt === undefined && status === "hold" ? new Date() : holdExpiresAt,
    })
    .returning();
}

beforeAll(async () => {
  const test = await createTestDb();
  db = test.db;
  close = () => test.client.close();
  await seedSampleData(db);

  const all = await db.select().from(schema.units).orderBy(schema.units.code);
  unitA = all.find((u) => u.code === "UBD-RVP-01")!;
  unitB = all.find((u) => u.code === "UBD-RVP-02")!;
  otherTypeUnit = all.find((u) => u.code === "UBD-CNP-01")!;

  const [guest] = await db
    .insert(schema.guests)
    .values({ fullName: "Test Guest", email: "guest@example.com" })
    .returning();
  guestId = guest.id;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(schema.reservations);
});

describe("migrations and seed", () => {
  it("creates the sample portfolio", async () => {
    const [{ properties, types, units }] = await db.execute<{
      properties: number;
      types: number;
      units: number;
    }>(sql`
      select (select count(*)::int from properties) as properties,
             (select count(*)::int from unit_types) as types,
             (select count(*)::int from units) as units
    `).then((r) => r.rows);
    expect({ properties, types, units }).toEqual({ properties: 2, types: 4, units: 9 });
  });

  it("guards exactly the statuses listed in OCCUPYING_STATUSES", async () => {
    const { rows } = await db.execute<{ def: string }>(sql`
      select pg_get_constraintdef(oid) as def
      from pg_constraint where conname = 'reservations_no_overlap'
    `);
    expect(rows).toHaveLength(1);
    const guarded = schema.reservationStatus.enumValues.filter((s) =>
      rows[0].def.includes(`'${s}'`),
    );
    expect(guarded.sort()).toEqual([...schema.OCCUPYING_STATUSES].sort());
  });
});

describe("double-booking guard", () => {
  it("rejects an overlapping stay on the same unit", async () => {
    await book({ checkIn: "2026-12-10", checkOut: "2026-12-14" });
    await expectSqlState(book({ checkIn: "2026-12-13", checkOut: "2026-12-15" }), EXCLUSION_VIOLATION);
    await expectSqlState(book({ checkIn: "2026-12-08", checkOut: "2026-12-20" }), EXCLUSION_VIOLATION);
  });

  it("allows back-to-back stays (check-out day = next check-in day)", async () => {
    await book({ checkIn: "2026-12-10", checkOut: "2026-12-14" });
    await expect(book({ checkIn: "2026-12-14", checkOut: "2026-12-16" })).resolves.toHaveLength(1);
    await expect(book({ checkIn: "2026-12-07", checkOut: "2026-12-10" })).resolves.toHaveLength(1);
  });

  it("allows the same dates on a different unit", async () => {
    await book({ checkIn: "2026-12-10", checkOut: "2026-12-14" });
    await expect(book({ unit: unitB, checkIn: "2026-12-10", checkOut: "2026-12-14" })).resolves.toHaveLength(1);
  });

  it("treats a hold as occupying until it is expired", async () => {
    const [hold] = await book({
      checkIn: "2026-12-10",
      checkOut: "2026-12-12",
      status: "hold",
      holdExpiresAt: new Date("2026-12-01T00:15:00Z"),
    });
    await expectSqlState(book({ checkIn: "2026-12-10", checkOut: "2026-12-12" }), EXCLUSION_VIOLATION);

    await db.update(schema.reservations).set({ status: "expired" }).where(eq(schema.reservations.id, hold.id));
    await expect(book({ checkIn: "2026-12-10", checkOut: "2026-12-12" })).resolves.toHaveLength(1);
  });

  it("frees nights on cancellation and blocks reinstating an overlapping stay", async () => {
    const [first] = await book({ checkIn: "2026-12-10", checkOut: "2026-12-12" });
    await db.update(schema.reservations).set({ status: "cancelled" }).where(eq(schema.reservations.id, first.id));
    await book({ checkIn: "2026-12-11", checkOut: "2026-12-13" });

    await expectSqlState(
      db.update(schema.reservations).set({ status: "confirmed" }).where(eq(schema.reservations.id, first.id)),
      EXCLUSION_VIOLATION,
    );
  });

  it("matches an in-memory model across many random stays", async () => {
    // Deterministic pseudo-random sequence so failures are reproducible.
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const accepted: Array<[number, number]> = [];
    const base = Date.UTC(2027, 0, 1);
    const day = (offset: number) => new Date(base + offset * 86_400_000).toISOString().slice(0, 10);

    for (let i = 0; i < 120; i += 1) {
      const start = Math.floor(next() * 60);
      const end = start + 1 + Math.floor(next() * 6);
      const overlaps = accepted.some(([s, e]) => start < e && s < end);
      const result = await book({ checkIn: day(start), checkOut: day(end) }).then(
        () => "ok",
        (e: unknown) => sqlState(e),
      );
      expect(result, `stay ${start}-${end}`).toBe(overlaps ? EXCLUSION_VIOLATION : "ok");
      if (!overlaps) accepted.push([start, end]);
    }
    expect(accepted.length).toBeGreaterThan(5);
  });
});

describe("data integrity", () => {
  it("rejects a unit that does not belong to the stated unit type", async () => {
    await expectSqlState(
      book({ checkIn: "2026-12-10", checkOut: "2026-12-12", unitTypeId: otherTypeUnit.unitTypeId }),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it("rejects a stay whose check-out is not after check-in", async () => {
    await expectSqlState(book({ checkIn: "2026-12-10", checkOut: "2026-12-10" }), CHECK_VIOLATION);
  });

  it("rejects a hold without an expiry time", async () => {
    await expectSqlState(
      book({ checkIn: "2026-12-10", checkOut: "2026-12-12", status: "hold", holdExpiresAt: null }),
      CHECK_VIOLATION,
    );
  });

  it("rejects a guest with neither email nor phone", async () => {
    await expectSqlState(db.insert(schema.guests).values({ fullName: "No Contact" }), CHECK_VIOLATION);
  });
});
