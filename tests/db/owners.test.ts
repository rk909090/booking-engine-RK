import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { createHold, createPendingPayment, recordPaymentPaid } from "@/domain/booking";
import { addExpense, addRecurring, assignUnit, buildStatements, createOwner, lockStatement, markStatementPaid, setCommissionRates, stopRecurring, voidExpense } from "@/domain/owners";
import { finishTask, reportMaintenance } from "@/domain/tasks";
import { createTestDb, type TestDb } from "./test-db";

/*
 * February 2027 (28 days). Owner A owns UBD-RVP-01 all month and buys
 * UBD-RVP-02 from owner B on 15 February. River Pavilion is Rp 6.500.000 a night.
 */
const at = (date: string) => new Date(`${date}T03:00:00Z`);
const RATE = 6_500_000;
const manager = { type: "staff" as const, id: "bm-1" };

let db: TestDb;
let close: () => Promise<void>;
let propertyId: string;
let units: Array<{ id: string; code: string }>;
let ownerA: string;
let ownerB: string;

async function stay(unit: number, checkIn: string, checkOut: string, source: "website" | "agent") {
  const [type] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.slug, "river-pavilion"));
  const h = await createHold(db, {
    unitTypeId: type.id, checkIn, checkOut, adults: 2, children: 0, guest: { fullName: "Guest", email: "g@example.com" },
    locale: "en", source, now: at("2027-01-02"), candidateUnitIds: [units[unit].id],
  });
  if (!h.ok) throw new Error(JSON.stringify(h.error));
  await createPendingPayment(db, { reservationId: h.reservation.id, provider: "simulated", providerRef: `o-${h.reservation.code}`, purpose: "full", amount: h.reservation.totalAmount, checkoutUrl: null, expiresAt: null });
  await recordPaymentPaid(db, { provider: "simulated", providerRef: `o-${h.reservation.code}`, amount: h.reservation.totalAmount, paidAt: at("2027-01-02") });
}

beforeAll(async () => {
  const test = await createTestDb();
  db = test.db;
  close = () => test.client.close();
  await seedSampleData(db);
  const [type] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.slug, "river-pavilion"));
  propertyId = type.propertyId;
  units = await db.select({ id: schema.units.id, code: schema.units.code }).from(schema.units).where(eq(schema.units.unitTypeId, type.id)).orderBy(schema.units.code);

  ownerA = ((await createOwner(db, { fullName: "Owner A", email: "a@example.com", actor: manager })) as { id: string }).id;
  ownerB = ((await createOwner(db, { fullName: "Owner B", actor: manager })) as { id: string }).id;
  expect((await assignUnit(db, { unitId: units[0].id, ownerId: ownerA, startDate: "2027-01-01", feeBp: 2000, actor: manager })).ok).toBe(true);
  expect((await assignUnit(db, { unitId: units[1].id, ownerId: ownerB, startDate: "2027-01-01", feeBp: 2500, actor: manager })).ok).toBe(true);
  expect((await assignUnit(db, { unitId: units[1].id, ownerId: ownerA, startDate: "2027-02-15", feeBp: 2000, actor: manager })).ok).toBe(true);
  await setCommissionRates(db, { propertyId, rates: { agent: 1000 }, actor: manager });

  await stay(0, "2027-01-30", "2027-02-03", "website"); // 2 nights in February
  await stay(0, "2027-02-10", "2027-02-12", "agent"); // agent: 10% commission
  await stay(1, "2027-02-13", "2027-02-17", "website"); // 13, 14 for B; 15, 16 for A
  expect((await addExpense(db, { unitId: units[0].id, date: "2027-02-05", category: "utilities", description: "PLN February", amount: 1_000_000, actor: manager })).ok).toBe(true);
  expect((await addRecurring(db, { unitId: units[1].id, category: "internet", description: "Wi-Fi", amount: 560_000, startMonth: "2027-01", actor: manager })).ok).toBe(true);
});
afterAll(async () => close());

describe("owner statements", () => {
  it("splits revenue, commission, fee and expenses per owner, including a sale mid-month", async () => {
    const report = await reportMaintenance(db, { unitId: units[0].id, title: "Pump replaced", actor: manager, now: at("2027-02-08") });
    expect(report.ok).toBe(true);
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.kind, "maintenance"));
    expect(await finishTask(db, { taskId: task.id, actor: manager, cost: 750_000, now: at("2027-02-09") })).toEqual({ ok: true });

    const rows = (await buildStatements(db, { propertyId, month: "2027-02" }))!;
    const a = rows.find((r) => r.ownerId === ownerA)!;
    const b = rows.find((r) => r.ownerId === ownerB)!;
    expect(a.status).toBe("draft");

    const a1 = a.data.units.find((u) => u.code === units[0].code)!;
    expect(a1).toMatchObject({ ownedNights: 28, soldNights: 4, roomRevenue: 4 * RATE, commission: 1_300_000, fee: Math.round((4 * RATE - 1_300_000) * 0.2), expenseTotal: 1_750_000 });
    expect(a1.expenses.map((e) => [e.source, e.amount])).toEqual([["manual", 1_000_000], ["maintenance", 750_000]]);
    expect(a1.payout).toBe(4 * RATE - 1_300_000 - 4_940_000 - 1_750_000);

    const a2 = a.data.units.find((u) => u.code === units[1].code)!;
    // From 15 February: 14 days owned, half the Wi-Fi.
    expect(a2).toMatchObject({ ownedNights: 14, soldNights: 2, roomRevenue: 2 * RATE, commission: 0, fee: 2_600_000, expenseTotal: 280_000 });
    expect(b.data.units).toHaveLength(1);
    expect(b.data.units[0]).toMatchObject({ ownedNights: 14, soldNights: 2, roomRevenue: 2 * RATE, fee: 3_250_000, expenseTotal: 280_000, payout: 13_000_000 - 3_250_000 - 280_000 });
    expect(a.data.totals.payout).toBe(a1.payout + a2.payout);
    expect(a1.stays.map((s) => [s.source, s.nights])).toEqual([["website", 2], ["agent", 2]]);
  });

  it("charges a ticket's cost only to a villa that has an owner", async () => {
    await reportMaintenance(db, { unitId: units[2].id, title: "Leak", actor: manager, now: at("2027-02-08") });
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.unitId, units[2].id));
    expect(await finishTask(db, { taskId: task.id, actor: manager, cost: 100_000, now: at("2027-02-09") })).toEqual({ ok: false, error: "cost_no_owner" });
    expect(await addExpense(db, { unitId: units[0].id, date: "2027-02-05", category: "utilities", description: "x", amount: -5 , actor: manager })).toEqual({ ok: false, error: "invalid" });
  });

  it("locks a finished month: frozen figures, no more changes for that owner, then the payout", async () => {
    expect(await lockStatement(db, { ownerId: ownerA, propertyId, month: "2027-02", today: "2027-02-20", actor: manager })).toEqual({ ok: false, error: "month_not_over" });
    const locked = await lockStatement(db, { ownerId: ownerA, propertyId, month: "2027-02", today: "2027-03-01", actor: manager });
    expect(locked.ok).toBe(true);
    expect(await lockStatement(db, { ownerId: ownerA, propertyId, month: "2027-02", today: "2027-03-01", actor: manager })).toEqual({ ok: false, error: "already_locked" });

    // Owner A's February is closed; owner B's is not.
    expect(await addExpense(db, { unitId: units[0].id, date: "2027-02-20", category: "repairs", description: "Late bill", amount: 50_000, actor: manager })).toEqual({ ok: false, error: "month_locked" });
    expect((await addExpense(db, { unitId: units[1].id, date: "2027-02-10", category: "repairs", description: "Door", amount: 50_000, actor: manager })).ok).toBe(true);
    const [first] = await db.select().from(schema.ownerExpenses).where(eq(schema.ownerExpenses.description, "PLN February"));
    expect(await voidExpense(db, { expenseId: first.id, reason: "Duplicate", actor: manager })).toEqual({ ok: false, error: "month_locked" });
    expect(await assignUnit(db, { unitId: units[0].id, ownerId: ownerB, startDate: "2027-02-20", feeBp: 2000, actor: manager })).toEqual({ ok: false, error: "month_locked" });
    expect(await stopRecurring(db, { recurringId: (await db.select().from(schema.recurringExpenses))[0].id, lastMonth: "2027-01", actor: manager })).toEqual({ ok: false, error: "month_locked" });

    const rows = (await buildStatements(db, { propertyId, month: "2027-02" }))!;
    const a = rows.find((r) => r.ownerId === ownerA)!;
    expect(a.status).toBe("locked");
    const [stored] = await db.select().from(schema.ownerStatements).where(eq(schema.ownerStatements.id, (locked as { id: string }).id));
    expect(stored.payout).toBe(a.data.totals.payout);
    expect(rows.find((r) => r.ownerId === ownerB)!.data.units[0].expenseTotal).toBe(330_000);

    expect(await markStatementPaid(db, { statementId: stored.id, reference: "BCA transfer 1 Mar", actor: manager })).toEqual({ ok: true });
    expect(await markStatementPaid(db, { statementId: stored.id, reference: "again", actor: manager })).toEqual({ ok: false, error: "already_paid" });
  });

  it("only moves ownership forward and keeps periods apart", async () => {
    expect(await assignUnit(db, { unitId: units[1].id, ownerId: ownerB, startDate: "2027-02-10", feeBp: 2000, actor: manager })).toEqual({ ok: false, error: "month_locked" });
    expect(await assignUnit(db, { unitId: units[2].id, ownerId: ownerB, startDate: "2027-04-01", feeBp: 12_000, actor: manager })).toEqual({ ok: false, error: "invalid" });
    expect((await assignUnit(db, { unitId: units[2].id, ownerId: ownerB, startDate: "2027-04-01", feeBp: 2000, actor: manager })).ok).toBe(true);
    expect(await assignUnit(db, { unitId: units[2].id, ownerId: ownerA, startDate: "2027-03-15", feeBp: 2000, actor: manager })).toEqual({ ok: false, error: "dates" });
  });
});
