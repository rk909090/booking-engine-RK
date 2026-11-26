import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { seedSampleData } from "@/db/seed-data";
import { cancelReservation, createHold, createPendingPayment, recordPaymentPaid } from "@/domain/booking";
import { changeUnitState, unitState } from "@/domain/housekeeping";
import { checkIn, checkOut } from "@/domain/operations";
import { savePreCheckin } from "@/domain/pre-checkin";
import { assignTask, claimTask, finishCleaning, finishInspection, finishTask, reportMaintenance, setInspectionChecklist } from "@/domain/tasks";
import { createTestDb, type TestDb } from "./test-db";

const at = (date: string, utc = "03:00") => new Date(`${date}T${utc}:00Z`);
const CHECKLIST = ["Bed made", "Bathroom clean", "Pool clean"];

let db: TestDb;
let close: () => Promise<void>;
let typeId: string;
let propertyId: string;
let unitIds: string[];
let hk1: { type: "staff"; id: string };
let hk2: { type: "staff"; id: string };
let outsider: string;

beforeAll(async () => {
  const test = await createTestDb();
  db = test.db;
  close = () => test.client.close();
  await seedSampleData(db);
  const [type] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.slug, "river-pavilion"));
  typeId = type.id;
  propertyId = type.propertyId;
  unitIds = (await db.select().from(schema.units).where(eq(schema.units.unitTypeId, typeId)).orderBy(schema.units.code)).map((u) => u.id);
  const [canggu] = await db.select().from(schema.properties).where(eq(schema.properties.slug, "canggu"));
  const made = await db
    .insert(schema.staffMembers)
    .values([
      { email: "hk1@example.com", fullName: "Made HK", role: "housekeeping" },
      { email: "hk2@example.com", fullName: "Nyoman HK", role: "housekeeping" },
      { email: "far@example.com", fullName: "Elsewhere", role: "housekeeping" },
    ])
    .returning();
  await db.insert(schema.staffPropertyAccess).values([
    { staffId: made[0].id, propertyId },
    { staffId: made[1].id, propertyId },
    { staffId: made[2].id, propertyId: canggu.id },
  ]);
  hk1 = { type: "staff", id: made[0].id };
  hk2 = { type: "staff", id: made[1].id };
  outsider = made[2].id;
});
afterAll(async () => close());
beforeEach(async () => {
  for (const table of [schema.tasks, schema.unitBlocks, schema.housekeepingEvents, schema.unitStatus, schema.preCheckinGuests, schema.preCheckins, schema.earlyCheckinRequests, schema.notificationOutbox, schema.payments, schema.auditEvents, schema.reservations, schema.guests]) {
    await db.delete(table);
  }
});

async function booking(unit: number, checkInDate: string, checkOutDate: string, requests: string | null = null, created = at("2027-01-05")) {
  const h = await createHold(db, {
    unitTypeId: typeId, checkIn: checkInDate, checkOut: checkOutDate, adults: 2, children: 0,
    guest: { fullName: "Guest", email: "g@example.com" }, locale: "en", source: "website", now: created, specialRequests: requests, candidateUnitIds: [unitIds[unit]],
  });
  if (!h.ok) throw new Error(JSON.stringify(h.error));
  await createPendingPayment(db, { reservationId: h.reservation.id, provider: "simulated", providerRef: `r-${h.reservation.code}`, purpose: "full", amount: h.reservation.totalAmount, checkoutUrl: null, expiresAt: null });
  await recordPaymentPaid(db, { provider: "simulated", providerRef: `r-${h.reservation.code}`, amount: h.reservation.totalAmount, paidAt: created });
  return h.reservation;
}
const tasksOf = (kind: string) => db.select().from(schema.tasks).where(eq(schema.tasks.kind, kind)).orderBy(schema.tasks.createdAt);

describe("cleaning and inspection follow the villa", () => {
  it("opens a cleaning task at check-out due when the next guest arrives, then inspection, then ready", async () => {
    const leaving = await booking(0, "2027-02-08", "2027-02-10");
    await booking(0, "2027-02-10", "2027-02-12");
    await checkIn(db, { reservationId: leaving.id, actor: hk1, now: at("2027-02-08") });
    await checkOut(db, { reservationId: leaving.id, actor: hk1, now: at("2027-02-10", "02:00") });
    const [clean] = await tasksOf("clean");
    expect(clean).toMatchObject({ unitId: unitIds[0], status: "open", dueDate: "2027-02-10", dueTime: "14:00:00", propertyId });

    expect(await finishCleaning(db, { taskId: clean.id, actor: hk1, now: at("2027-02-10", "03:00") })).toEqual({ ok: true });
    expect(await unitState(db, unitIds[0])).toBe("inspect");
    expect((await tasksOf("clean"))[0]).toMatchObject({ status: "done", completedBy: hk1.id });
    const [inspect] = await tasksOf("inspect");
    expect(inspect).toMatchObject({ status: "open", dueDate: "2027-02-10" });

    expect(await finishInspection(db, { taskId: inspect.id, checklist: CHECKLIST, ticked: CHECKLIST.slice(0, 2), passed: true, actor: hk2 })).toEqual({ ok: false, error: "checklist_incomplete" });
    expect(await finishInspection(db, { taskId: inspect.id, checklist: CHECKLIST, ticked: CHECKLIST.slice(0, 2), passed: false, actor: hk2 })).toEqual({ ok: false, error: "note_required" });
    expect(await finishInspection(db, { taskId: inspect.id, checklist: CHECKLIST, ticked: CHECKLIST.slice(0, 2), passed: false, note: "Leaves in the pool", actor: hk2 })).toEqual({ ok: true });
    expect(await unitState(db, unitIds[0])).toBe("dirty");
    expect((await tasksOf("inspect")).find((t) => t.id === inspect.id)).toMatchObject({ status: "done", result: "failed", checklist: [{ item: "Bed made", ok: true }, { item: "Bathroom clean", ok: true }, { item: "Pool clean", ok: false }] });
    const reclean = (await tasksOf("clean")).find((t) => t.status === "open")!;
    expect(reclean).toMatchObject({ status: "open", notes: "Leaves in the pool" });

    await finishCleaning(db, { taskId: reclean.id, actor: hk1 });
    const second = (await tasksOf("inspect")).find((t) => t.status === "open")!;
    expect(await finishInspection(db, { taskId: second.id, checklist: CHECKLIST, ticked: CHECKLIST, passed: true, actor: hk2 })).toEqual({ ok: true });
    expect(await unitState(db, unitIds[0])).toBe("ready");
  });

  it("stays in step when staff change the state on the villa status board", async () => {
    await changeUnitState(db, { unitId: unitIds[1], to: "dirty", actor: hk1 });
    expect((await tasksOf("clean")).map((t) => t.status)).toEqual(["open"]);
    // Marking dirty twice does not open a second cleaning task.
    await changeUnitState(db, { unitId: unitIds[1], to: "inspect", actor: hk1 });
    await changeUnitState(db, { unitId: unitIds[1], to: "ready", actor: hk1 });
    expect((await tasksOf("clean")).map((t) => t.status)).toEqual(["done"]);
    expect((await tasksOf("inspect")).map((t) => t.status)).toEqual(["done"]);
  });

  it("keeps a villa type's own checklist", async () => {
    await setInspectionChecklist(db, { unitTypeId: typeId, items: ["  Bed made ", "", "Pool clean", "Bed made"], actor: hk1 });
    const [type] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.id, typeId));
    expect(type.content.inspectionChecklist).toEqual(["Bed made", "Pool clean"]);
  });
});

describe("assigning", () => {
  it("lets staff take a free task once, and assigns only staff of the property", async () => {
    await changeUnitState(db, { unitId: unitIds[2], to: "dirty", actor: hk1 });
    const [task] = await tasksOf("clean");
    expect(await claimTask(db, { taskId: task.id, actor: hk1 })).toEqual({ ok: true });
    expect(await claimTask(db, { taskId: task.id, actor: hk2 })).toEqual({ ok: false, error: "already_assigned" });
    expect(await assignTask(db, { taskId: task.id, assigneeId: outsider, actor: hk1 })).toEqual({ ok: false, error: "invalid_assignee" });
    expect(await assignTask(db, { taskId: task.id, assigneeId: hk2.id, actor: hk1 })).toEqual({ ok: true });
    expect((await tasksOf("clean"))[0].assigneeId).toBe(hk2.id);
  });

  it("lets a director take or be given a task at any property", async () => {
    const [dir] = await db.insert(schema.staffMembers).values({ email: "dir@example.com", fullName: "Director", role: "director" }).returning();
    // Directors have no property rows: they work on every property.
    await changeUnitState(db, { unitId: unitIds[1], to: "dirty", actor: hk1 });
    const [task] = await tasksOf("clean");
    expect(await claimTask(db, { taskId: task.id, actor: { type: "staff", id: dir.id } })).toEqual({ ok: true });
    expect(await assignTask(db, { taskId: task.id, assigneeId: dir.id, actor: hk1 })).toEqual({ ok: true });
  });
});

describe("maintenance tickets", () => {
  it("can block the villa until fixed (not over bookings), and finishing ends the block and asks for an inspection", async () => {
    const now = at("2027-01-05");
    await booking(1, "2027-01-07", "2027-01-09");
    const refused = await reportMaintenance(db, { unitId: unitIds[1], title: "AC leaking", blockUntil: "2027-01-10", actor: hk1, now });
    expect(refused).toMatchObject({ ok: false, error: "blocked_dates_taken" });

    const made = await reportMaintenance(db, { unitId: unitIds[0], title: "AC leaking", notes: "Master bedroom", blockUntil: "2027-01-08", actor: hk1, now });
    expect(made.ok).toBe(true);
    const [ticket] = await tasksOf("maintenance");
    expect(ticket.blockId).toBeTruthy();
    const [block] = await db.select().from(schema.unitBlocks).where(eq(schema.unitBlocks.id, ticket.blockId!));
    expect(block).toMatchObject({ status: "open", startDate: "2027-01-05", endDate: "2027-01-08", reason: "AC leaking" });

    expect(await finishTask(db, { taskId: ticket.id, actor: hk2, note: "Refilled gas", now })).toEqual({ ok: true });
    const [after] = await db.select().from(schema.unitBlocks).where(eq(schema.unitBlocks.id, ticket.blockId!));
    expect(after.status).toBe("resolved");
    expect(await unitState(db, unitIds[0])).toBe("inspect");
    expect((await tasksOf("inspect")).map((t) => t.status)).toEqual(["open"]);
    expect((await tasksOf("maintenance"))[0]).toMatchObject({ status: "done", notes: "Master bedroom\nRefilled gas" });
  });
});

describe("guest requests", () => {
  it("turns booking and pre-check-in requests into tasks due at arrival, follows edits, and cancels them with the booking", async () => {
    const r = await booking(0, "2027-02-10", "2027-02-12", "Baby cot please");
    let requests = await tasksOf("request");
    expect(requests).toMatchObject([{ source: "booking", notes: "Baby cot please", dueDate: "2027-02-10", dueTime: "14:00:00", status: "open", unitId: unitIds[0] }]);

    const form = (text: string) => ({
      reservationId: r.id, arrivalTime: "", flightNumber: "", landingDate: "", landingTime: "", transferRequested: false, transferNote: "", requests: text, acceptRules: true,
      guests: [0, 1].map(() => ({ fullName: "Guest Name", nationality: "AU", birthDate: "1990-01-01", documentType: "passport", documentNumber: "PA123456" })),
      now: at("2027-02-01"),
    });
    await savePreCheckin(db, form("Birthday cake on arrival"), (s) => `sealed:${s}`);
    await savePreCheckin(db, form("Birthday cake and flowers"), (s) => `sealed:${s}`);
    requests = await db.select().from(schema.tasks).where(and(eq(schema.tasks.kind, "request"), eq(schema.tasks.source, "precheckin")));
    expect(requests).toMatchObject([{ notes: "Birthday cake and flowers", status: "open" }]);

    await cancelReservation(db, { reservationId: r.id, actor: { type: "guest" }, now: at("2027-02-02") });
    expect((await tasksOf("request")).map((t) => t.status)).toEqual(["cancelled", "cancelled"]);
  });
});
