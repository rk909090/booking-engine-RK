import { and, or, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { isIsoDate, todayIn } from "./dates";
import { changeUnitState, createBlock, resolveBlock } from "./housekeeping";
import { checkExpense, insertExpense } from "./owners";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Tx = Parameters<Parameters<AnyDb["transaction"]>[0]>[0];
type Executor = AnyDb | Tx;
type Actor = { type: "staff"; id: string };
export type Task = typeof schema.tasks.$inferSelect;

/*
 * Tasks (decided with the owner, 26 Nov 2026):
 * - Cleaning and inspection follow the villa's cleaning state (see
 *   syncCleaningTasks in housekeeping.ts): a check-out opens "clean", which
 *   is due when the next guest needs the villa; finishing it opens
 *   "inspect"; inspection goes through the villa type's checklist and either
 *   passes (villa ready) or fails (back to cleaning, with the reason).
 * - Maintenance tickets: report, assign, fix; a ticket can take the villa out
 *   of sale until a date, and finishing it ends that block.
 * - Guests' special requests (from the booking and the pre-check-in) become
 *   tasks due at their arrival.
 * Branch managers and front office assign; anyone working tasks can also
 * claim one nobody has.
 */

export const TASK_KINDS = ["clean", "inspect", "maintenance", "request"] as const;
const ACTIVE = ["open", "in_progress"] as const;
const ASSIGNABLE_ROLES = ["branch_manager", "front_office", "housekeeping"] as const;

export type TaskError =
  | "not_found"
  | "not_active"
  | "wrong_kind"
  | "invalid_assignee"
  | "already_assigned"
  | "checklist_incomplete"
  | "note_required"
  | "invalid_title"
  | "invalid_dates"
  | "blocked_dates_taken"
  | "unit_state"
  | "invalid_cost"
  | "cost_no_owner"
  | "cost_month_locked";

type Result = { ok: true } | { ok: false; error: TaskError; codes?: string[] };

async function loadTask(db: Executor, taskId: string) {
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
  return task ?? null;
}

async function audit(db: Executor, task: Pick<Task, "propertyId" | "id">, actor: Actor, action: string, after: object, now: Date) {
  await db.insert(schema.auditEvents).values({
    actorType: actor.type,
    actorId: actor.id,
    propertyId: task.propertyId,
    entityType: "task",
    entityId: task.id,
    action,
    after,
    occurredAt: now,
  });
}

/**
 * Staff who can be given tasks at a property: active branch managers, front
 * office and housekeeping with access to it, and active directors (who work
 * on every property).
 */
export async function assignableStaff(db: Executor, propertyId: string) {
  return db
    .select({ id: schema.staffMembers.id, fullName: schema.staffMembers.fullName, role: schema.staffMembers.role })
    .from(schema.staffMembers)
    .where(
      and(
        eq(schema.staffMembers.isActive, true),
        or(
          eq(schema.staffMembers.role, "director"),
          and(
            inArray(schema.staffMembers.role, [...ASSIGNABLE_ROLES]),
            sql`EXISTS (SELECT 1 FROM ${schema.staffPropertyAccess} a WHERE a.staff_id = ${schema.staffMembers.id} AND a.property_id = ${propertyId})`,
          ),
        ),
      ),
    )
    .orderBy(asc(schema.staffMembers.fullName));
}

/** Gives a task to someone (or to nobody, with null). */
export async function assignTask(db: AnyDb, input: { taskId: string; assigneeId: string | null; actor: Actor; now?: Date }): Promise<Result> {
  const now = input.now ?? new Date();
  const task = await loadTask(db, input.taskId);
  if (!task) return { ok: false, error: "not_found" };
  if (!(ACTIVE as readonly string[]).includes(task.status)) return { ok: false, error: "not_active" };
  if (input.assigneeId && !(await assignableStaff(db, task.propertyId)).some((s) => s.id === input.assigneeId)) return { ok: false, error: "invalid_assignee" };
  await db.update(schema.tasks).set({ assigneeId: input.assigneeId, updatedAt: now }).where(eq(schema.tasks.id, task.id));
  await audit(db, task, input.actor, "task.assigned", { assignee: input.assigneeId }, now);
  return { ok: true };
}

/** Takes a task nobody has yet. */
export async function claimTask(db: AnyDb, input: { taskId: string; actor: Actor; now?: Date }): Promise<Result> {
  const now = input.now ?? new Date();
  const task = await loadTask(db, input.taskId);
  if (!task) return { ok: false, error: "not_found" };
  if (!(ACTIVE as readonly string[]).includes(task.status)) return { ok: false, error: "not_active" };
  if (!(await assignableStaff(db, task.propertyId)).some((s) => s.id === input.actor.id)) return { ok: false, error: "invalid_assignee" };
  // Only if still free: two people tapping "take" at once cannot both get it.
  const [taken] = await db
    .update(schema.tasks)
    .set({ assigneeId: input.actor.id, updatedAt: now })
    .where(and(eq(schema.tasks.id, task.id), sql`${schema.tasks.assigneeId} IS NULL`))
    .returning({ id: schema.tasks.id });
  if (!taken) return { ok: false, error: "already_assigned" };
  await audit(db, task, input.actor, "task.claimed", {}, now);
  return { ok: true };
}

/** Marks a task as being worked on (taking it if nobody has it). */
export async function startTask(db: AnyDb, input: { taskId: string; actor: Actor; now?: Date }): Promise<Result> {
  const now = input.now ?? new Date();
  const task = await loadTask(db, input.taskId);
  if (!task) return { ok: false, error: "not_found" };
  if (task.status !== "open") return { ok: false, error: "not_active" };
  await db
    .update(schema.tasks)
    .set({ status: "in_progress", startedAt: now, assigneeId: task.assigneeId ?? input.actor.id, updatedAt: now })
    .where(eq(schema.tasks.id, task.id));
  return { ok: true };
}

/** The villa is clean: it moves on to inspection (which opens the inspection task). */
export async function finishCleaning(db: AnyDb, input: { taskId: string; actor: Actor; note?: string | null; now?: Date }): Promise<Result> {
  const task = await loadTask(db, input.taskId);
  if (!task) return { ok: false, error: "not_found" };
  if (task.kind !== "clean" || !task.unitId) return { ok: false, error: "wrong_kind" };
  if (!(ACTIVE as readonly string[]).includes(task.status)) return { ok: false, error: "not_active" };
  const moved = await changeUnitState(db, { unitId: task.unitId, to: "inspect", actor: input.actor, note: input.note, now: input.now });
  return moved.ok ? { ok: true } : { ok: false, error: "unit_state" };
}

/**
 * Records an inspection. Passing needs every checklist item ticked and makes
 * the villa ready; failing needs a note and sends it back to cleaning.
 */
export async function finishInspection(
  db: AnyDb,
  input: { taskId: string; checklist: string[]; ticked: string[]; passed: boolean; note?: string | null; actor: Actor; now?: Date },
): Promise<Result> {
  const now = input.now ?? new Date();
  const task = await loadTask(db, input.taskId);
  if (!task) return { ok: false, error: "not_found" };
  if (task.kind !== "inspect" || !task.unitId) return { ok: false, error: "wrong_kind" };
  if (!(ACTIVE as readonly string[]).includes(task.status)) return { ok: false, error: "not_active" };
  const results = input.checklist.map((item) => ({ item, ok: input.ticked.includes(item) }));
  const note = input.note?.trim().slice(0, 500) || null;
  if (input.passed && results.some((r) => !r.ok)) return { ok: false, error: "checklist_incomplete" };
  if (!input.passed && !note) return { ok: false, error: "note_required" };
  const moved = await changeUnitState(db, { unitId: task.unitId, to: input.passed ? "ready" : "dirty", actor: input.actor, note: input.passed ? null : note, now });
  if (!moved.ok) return { ok: false, error: "unit_state" };
  await db
    .update(schema.tasks)
    .set({ status: "done", result: input.passed ? "passed" : "failed", checklist: results, notes: note ?? task.notes, completedAt: now, completedBy: input.actor.id, updatedAt: now })
    .where(eq(schema.tasks.id, task.id));
  await audit(db, task, input.actor, input.passed ? "task.inspection_passed" : "task.inspection_failed", { failed: results.filter((r) => !r.ok).map((r) => r.item), note }, now);
  return { ok: true };
}

/** Reports something to fix; optionally takes the villa out of sale from today until `blockUntil` (exclusive). */
export async function reportMaintenance(
  db: AnyDb,
  input: { unitId: string; title: string; notes?: string | null; blockUntil?: string | null; actor: Actor; now?: Date },
): Promise<Result & { taskId?: string }> {
  const now = input.now ?? new Date();
  const title = input.title.trim().replace(/\s+/g, " ").slice(0, 160);
  if (title.length < 3) return { ok: false, error: "invalid_title" };
  const [unit] = await db
    .select({ id: schema.units.id, propertyId: schema.units.propertyId, timezone: schema.properties.timezone })
    .from(schema.units)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.units.propertyId))
    .where(eq(schema.units.id, input.unitId));
  if (!unit) return { ok: false, error: "not_found" };
  let blockId: string | null = null;
  if (input.blockUntil) {
    const today = todayIn(unit.timezone, now);
    if (!isIsoDate(input.blockUntil) || input.blockUntil <= today) return { ok: false, error: "invalid_dates" };
    const blocked = await createBlock(db, { unitId: unit.id, startDate: today, endDate: input.blockUntil, reason: title, actor: input.actor, now });
    if (!blocked.ok) return { ok: false, error: blocked.error === "conflicts_with_bookings" ? "blocked_dates_taken" : "invalid_dates", codes: "codes" in blocked ? blocked.codes : undefined };
    const [block] = await db
      .select({ id: schema.unitBlocks.id })
      .from(schema.unitBlocks)
      .where(and(eq(schema.unitBlocks.unitId, unit.id), eq(schema.unitBlocks.status, "open"), eq(schema.unitBlocks.startDate, today)))
      .orderBy(desc(schema.unitBlocks.createdAt))
      .limit(1);
    blockId = block?.id ?? null;
  }
  const [task] = await db
    .insert(schema.tasks)
    .values({ propertyId: unit.propertyId, unitId: unit.id, kind: "maintenance", title, notes: input.notes?.trim().slice(0, 1000) || null, blockId, createdBy: input.actor.id, createdAt: now, updatedAt: now })
    .returning();
  await audit(db, task, input.actor, "task.maintenance_reported", { title, blocked: Boolean(blockId) }, now);
  return { ok: true, taskId: task.id };
}

/** Finishes a maintenance ticket or a guest request. A ticket's block ends with it (the villa then needs an inspection). */
/**
 * Finishes a maintenance ticket or guest request. A maintenance ticket may
 * carry its cost: it is then charged to the villa's owner (see domain/owners.ts).
 */
export async function finishTask(db: AnyDb, input: { taskId: string; actor: Actor; note?: string | null; cost?: number | null; now?: Date }): Promise<Result> {
  const now = input.now ?? new Date();
  const task = await loadTask(db, input.taskId);
  if (!task) return { ok: false, error: "not_found" };
  if (task.kind !== "maintenance" && task.kind !== "request") return { ok: false, error: "wrong_kind" };
  if (!(ACTIVE as readonly string[]).includes(task.status)) return { ok: false, error: "not_active" };
  let expense: { input: Parameters<typeof insertExpense>[1]; propertyId: string } | null = null;
  if (input.cost !== undefined && input.cost !== null) {
    if (task.kind !== "maintenance" || !task.unitId || !Number.isSafeInteger(input.cost) || input.cost <= 0) return { ok: false, error: "invalid_cost" };
    const [property] = await db.select({ timezone: schema.properties.timezone }).from(schema.properties).where(eq(schema.properties.id, task.propertyId));
    const cost = { unitId: task.unitId, date: todayIn(property?.timezone ?? "Asia/Makassar", now), category: "repairs", description: task.title, amount: input.cost, source: "maintenance" as const, taskId: task.id, actor: input.actor };
    const checked = await checkExpense(db, cost);
    if (!checked.ok) return { ok: false, error: checked.error === "no_owner" ? "cost_no_owner" : checked.error === "month_locked" ? "cost_month_locked" : "invalid_cost" };
    expense = { input: cost, propertyId: checked.propertyId };
  }
  if (expense) await insertExpense(db, expense.input, expense.propertyId);
  if (task.blockId) {
    const [block] = await db.select({ status: schema.unitBlocks.status }).from(schema.unitBlocks).where(eq(schema.unitBlocks.id, task.blockId));
    if (block?.status === "open") await resolveBlock(db, { blockId: task.blockId, actor: input.actor, now });
  }
  const note = input.note?.trim().slice(0, 500);
  await db
    .update(schema.tasks)
    .set({ status: "done", completedAt: now, completedBy: input.actor.id, notes: note ? [task.notes, note].filter(Boolean).join("\n") : task.notes, updatedAt: now })
    .where(eq(schema.tasks.id, task.id));
  await audit(db, task, input.actor, "task.done", { kind: task.kind }, now);
  return { ok: true };
}

/** Cancels a maintenance ticket or request that is no longer needed (ending a ticket's block). */
export async function cancelTask(db: AnyDb, input: { taskId: string; actor: Actor; now?: Date }): Promise<Result> {
  const now = input.now ?? new Date();
  const task = await loadTask(db, input.taskId);
  if (!task) return { ok: false, error: "not_found" };
  if (task.kind !== "maintenance" && task.kind !== "request") return { ok: false, error: "wrong_kind" };
  if (!(ACTIVE as readonly string[]).includes(task.status)) return { ok: false, error: "not_active" };
  if (task.blockId) {
    const [block] = await db.select({ status: schema.unitBlocks.status }).from(schema.unitBlocks).where(eq(schema.unitBlocks.id, task.blockId));
    if (block?.status === "open") await resolveBlock(db, { blockId: task.blockId, actor: input.actor, now });
  }
  await db.update(schema.tasks).set({ status: "cancelled", completedAt: now, completedBy: input.actor.id, updatedAt: now }).where(eq(schema.tasks.id, task.id));
  await audit(db, task, input.actor, "task.cancelled", { kind: task.kind }, now);
  return { ok: true };
}

/**
 * Keeps the request task of a booking in step with a guest's request text:
 * creates it (due at arrival), updates it, or cancels it when the text is
 * cleared. Call inside the transaction that changes the request.
 */
export async function syncRequestTask(db: Executor, input: { reservationId: string; source: "booking" | "precheckin"; text: string | null | undefined; now: Date }) {
  const text = input.text?.trim().slice(0, 1000) || null;
  const [r] = await db
    .select({ id: schema.reservations.id, code: schema.reservations.code, propertyId: schema.reservations.propertyId, unitId: schema.reservations.unitId, checkIn: schema.reservations.checkIn, checkInTime: schema.properties.checkInTime })
    .from(schema.reservations)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .where(eq(schema.reservations.id, input.reservationId));
  if (!r) return;
  const [existing] = await db
    .select({ id: schema.tasks.id, notes: schema.tasks.notes })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.reservationId, r.id), eq(schema.tasks.kind, "request"), eq(schema.tasks.source, input.source), inArray(schema.tasks.status, [...ACTIVE])));
  if (!text) {
    if (existing) await db.update(schema.tasks).set({ status: "cancelled", completedAt: input.now, completedBy: "system", updatedAt: input.now }).where(eq(schema.tasks.id, existing.id));
    return;
  }
  if (existing) {
    if (existing.notes !== text) await db.update(schema.tasks).set({ notes: text, dueDate: r.checkIn, updatedAt: input.now }).where(eq(schema.tasks.id, existing.id));
    return;
  }
  await db.insert(schema.tasks).values({
    propertyId: r.propertyId,
    unitId: r.unitId,
    reservationId: r.id,
    kind: "request",
    source: input.source,
    title: `Guest request ${r.code}`,
    notes: text,
    dueDate: r.checkIn,
    dueTime: r.checkInTime.slice(0, 5),
    createdBy: "system",
    createdAt: input.now,
    updatedAt: input.now,
  });
}

/** Cancels the open request tasks (and add-on orders) of a booking that will not arrive (cancelled, no-show). */
export async function cancelReservationTasks(db: Executor, reservationId: string, now: Date) {
  await db
    .update(schema.addonOrders)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(schema.addonOrders.reservationId, reservationId), inArray(schema.addonOrders.status, ["requested", "confirmed"])));
  await db
    .update(schema.tasks)
    .set({ status: "cancelled", completedAt: now, completedBy: "system", updatedAt: now })
    .where(and(eq(schema.tasks.reservationId, reservationId), eq(schema.tasks.kind, "request"), inArray(schema.tasks.status, [...ACTIVE])));
}

/** Saves the inspection checklist of a villa type (one item per line, blanks dropped). */
export async function setInspectionChecklist(db: AnyDb, input: { unitTypeId: string; items: string[]; actor: Actor; now?: Date }): Promise<Result> {
  const now = input.now ?? new Date();
  const items = [...new Set(input.items.map((i) => i.trim().replace(/\s+/g, " ").slice(0, 120)).filter(Boolean))].slice(0, 40);
  const [type] = await db.select({ id: schema.unitTypes.id, propertyId: schema.unitTypes.propertyId, content: schema.unitTypes.content }).from(schema.unitTypes).where(eq(schema.unitTypes.id, input.unitTypeId));
  if (!type) return { ok: false, error: "not_found" };
  await db
    .update(schema.unitTypes)
    .set({ content: { ...type.content, inspectionChecklist: items.length ? items : undefined }, updatedAt: now })
    .where(eq(schema.unitTypes.id, type.id));
  await db.insert(schema.auditEvents).values({ actorType: "staff", actorId: input.actor.id, propertyId: type.propertyId, entityType: "unit_type", entityId: type.id, action: "unit_type.checklist_changed", after: { items }, occurredAt: now });
  return { ok: true };
}

/** Active tasks of some properties, plus those finished since yesterday, soonest due first. */
export async function taskBoard(db: AnyDb, input: { propertyIds: string[]; now?: Date }) {
  if (input.propertyIds.length === 0) return [];
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - 24 * 3_600_000);
  return db
    .select({
      task: schema.tasks,
      unitCode: schema.units.code,
      unitTypeId: schema.units.unitTypeId,
      typeContent: schema.unitTypes.content,
      assigneeName: schema.staffMembers.fullName,
      reservationCode: schema.reservations.code,
    })
    .from(schema.tasks)
    .leftJoin(schema.units, eq(schema.units.id, schema.tasks.unitId))
    .leftJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.units.unitTypeId))
    .leftJoin(schema.staffMembers, eq(schema.staffMembers.id, schema.tasks.assigneeId))
    .leftJoin(schema.reservations, eq(schema.reservations.id, schema.tasks.reservationId))
    .where(
      and(
        inArray(schema.tasks.propertyId, input.propertyIds),
        sql`(${inArray(schema.tasks.status, [...ACTIVE])} OR (${schema.tasks.status} = 'done' AND ${gte(schema.tasks.completedAt, since)}))`,
      ),
    )
    .orderBy(sql`${schema.tasks.dueDate} ASC NULLS LAST`, sql`${schema.tasks.dueTime} ASC NULLS LAST`, asc(schema.tasks.createdAt));
}

/** Whether a task is late or due within two hours, given the property's local date and time. */
export function urgency(task: Pick<Task, "dueDate" | "dueTime" | "status">, today: string, nowTime: string): "late" | "soon" | "today" | "later" | null {
  if (!task.dueDate || task.status === "done" || task.status === "cancelled") return null;
  if (task.dueDate < today) return "late";
  if (task.dueDate > today) return "later";
  if (!task.dueTime) return "today";
  const [h, m] = task.dueTime.slice(0, 5).split(":").map(Number);
  const [nh, nm] = nowTime.split(":").map(Number);
  const minutes = h * 60 + m - (nh * 60 + nm);
  return minutes < 0 ? "late" : minutes <= 120 ? "soon" : "today";
}
