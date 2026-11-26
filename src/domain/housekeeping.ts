import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { isIsoDate, todayIn } from "./dates";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Tx = Parameters<Parameters<AnyDb["transaction"]>[0]>[0];
type Executor = AnyDb | Tx;
export type HkState = (typeof schema.housekeepingState.enumValues)[number];
export type Actor = { type: "staff" | "system"; id?: string };

/*
 * Villa readiness. The recorded cleaning state lives in unit_status;
 * occupancy comes from reservations and out-of-order from unit_blocks.
 * Turnover: check-out -> dirty -> (cleaned) inspect -> (inspected) ready.
 */

const TRANSITIONS: Record<HkState, HkState[]> = {
  dirty: ["inspect"],
  inspect: ["ready", "dirty"],
  ready: ["dirty"],
};

export function canTransition(from: HkState, to: HkState): boolean {
  return TRANSITIONS[from].includes(to);
}

export type Readiness = "maintenance" | "occupied" | "dirty" | "inspect" | "ready";

/**
 * What the unit needs today, most urgent first. A unit with a guest
 * arriving today that is not ready is the top priority.
 */
export function readiness(f: {
  state: HkState;
  occupied: boolean;
  blockedToday: boolean;
  arrivalToday: boolean;
  /** The guest in the villa leaves today. */
  departingToday?: boolean;
}): { readiness: Readiness; priority: number; needsAttention: boolean } {
  const readinessValue: Readiness = f.blockedToday ? "maintenance" : f.occupied ? "occupied" : f.state;
  const urgent = f.arrivalToday && readinessValue !== "ready" && readinessValue !== "occupied";
  // Same-day turnover: still occupied, but must be emptied, cleaned and inspected today.
  const turnover = readinessValue === "occupied" && f.departingToday === true && f.arrivalToday;
  const order: Record<Readiness, number> = { maintenance: 2, dirty: 3, inspect: 4, occupied: 6, ready: 7 };
  const priority = urgent ? 0 : turnover ? 1 : order[readinessValue];
  return { readiness: readinessValue, priority, needsAttention: priority <= 4 };
}

/** Recorded state of a unit; units never recorded count as ready. */
export async function unitState(db: Executor, unitId: string): Promise<HkState> {
  const [row] = await db.select({ state: schema.unitStatus.state }).from(schema.unitStatus).where(eq(schema.unitStatus.unitId, unitId));
  return row?.state ?? "ready";
}

/** Writes the state and its history entry. Call inside a transaction. */
export async function recordState(tx: Executor, unitId: string, from: HkState, to: HkState, actor: Actor, note: string | null, now: Date) {
  await tx
    .insert(schema.unitStatus)
    .values({ unitId, state: to, note, updatedBy: actor.id ?? actor.type, updatedAt: now })
    .onConflictDoUpdate({ target: schema.unitStatus.unitId, set: { state: to, note, updatedBy: actor.id ?? actor.type, updatedAt: now } });
  await tx.insert(schema.housekeepingEvents).values({
    unitId,
    fromState: from,
    toState: to,
    actorType: actor.type,
    actorId: actor.id ?? null,
    note,
    occurredAt: now,
  });
  await syncCleaningTasks(tx, unitId, to, actor, note, now);
}

const ACTIVE_TASK = ["open", "in_progress"] as const;

/** The next guest due in this villa (today or later): when the villa must be ready. */
async function nextArrivalDue(tx: Executor, unitId: string, today: string, checkInTime: string) {
  const [next] = await tx
    .select({ id: schema.reservations.id, checkIn: schema.reservations.checkIn })
    .from(schema.reservations)
    .where(and(eq(schema.reservations.unitId, unitId), eq(schema.reservations.status, "confirmed"), sql`${schema.reservations.checkIn} >= ${today}`))
    .orderBy(schema.reservations.checkIn)
    .limit(1);
  if (!next) return { dueDate: null, dueTime: null };
  const [early] = await tx
    .select({ time: schema.earlyCheckinRequests.requestedTime })
    .from(schema.earlyCheckinRequests)
    .where(and(eq(schema.earlyCheckinRequests.reservationId, next.id), eq(schema.earlyCheckinRequests.status, "approved"), eq(schema.earlyCheckinRequests.forDate, next.checkIn)))
    .limit(1);
  return { dueDate: next.checkIn, dueTime: (early?.time ?? checkInTime).slice(0, 5) };
}

/**
 * Keeps cleaning tasks in step with the villa's state (see domain/tasks.ts):
 * dirty opens a cleaning task, inspect closes it and opens an inspection,
 * ready closes both. Runs inside the transaction that changes the state.
 */
async function syncCleaningTasks(tx: Executor, unitId: string, to: HkState, actor: Actor, note: string | null, now: Date) {
  const [unit] = await tx
    .select({ propertyId: schema.units.propertyId, checkInTime: schema.properties.checkInTime, timezone: schema.properties.timezone })
    .from(schema.units)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.units.propertyId))
    .where(eq(schema.units.id, unitId));
  if (!unit) return;
  const by = actor.id ?? actor.type;
  const finish = (kind: "clean" | "inspect", status: "done" | "cancelled") =>
    tx
      .update(schema.tasks)
      .set({ status, completedAt: now, completedBy: by, updatedAt: now })
      .where(and(eq(schema.tasks.unitId, unitId), eq(schema.tasks.kind, kind), inArray(schema.tasks.status, [...ACTIVE_TASK])));
  const open = async (kind: "clean" | "inspect") => {
    const due = await nextArrivalDue(tx, unitId, todayIn(unit.timezone, now), unit.checkInTime);
    await tx
      .insert(schema.tasks)
      .values({ propertyId: unit.propertyId, unitId, kind, title: kind === "clean" ? "Clean villa" : "Inspect villa", notes: note, ...due, createdBy: by, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
  };
  if (to === "dirty") {
    await finish("inspect", "cancelled");
    await open("clean");
  } else if (to === "inspect") {
    await finish("clean", "done");
    await open("inspect");
  } else {
    await finish("clean", "done");
    await finish("inspect", "done");
  }
}

export async function openBlockToday(db: Executor, unitId: string, today: string) {
  const [row] = await db
    .select({ id: schema.unitBlocks.id, reason: schema.unitBlocks.reason, endDate: schema.unitBlocks.endDate })
    .from(schema.unitBlocks)
    .where(
      and(
        eq(schema.unitBlocks.unitId, unitId),
        eq(schema.unitBlocks.status, "open"),
        sql`daterange(${schema.unitBlocks.startDate}, ${schema.unitBlocks.endDate}, '[)') @> ${today}::date`,
      ),
    )
    .limit(1);
  return row ?? null;
}

export type HkError = "not_found" | "invalid_transition" | "occupied" | "invalid_dates" | "conflicts_with_bookings" | "overlaps_block" | "already_resolved";
export type HkResult = { ok: true } | { ok: false; error: HkError; codes?: string[] };

async function lockUnit(tx: Tx, unitId: string) {
  const [unit] = await tx
    .select({ id: schema.units.id, propertyId: schema.units.propertyId, timezone: schema.properties.timezone })
    .from(schema.units)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.units.propertyId))
    .where(eq(schema.units.id, unitId))
    .for("update", { of: schema.units });
  return unit ?? null;
}

/** Moves a unit along the cleaning flow (cleaned, inspected, failed inspection, mark dirty). */
export async function changeUnitState(
  db: AnyDb,
  input: { unitId: string; to: HkState; actor: Actor; note?: string | null; now?: Date },
): Promise<HkResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const unit = await lockUnit(tx, input.unitId);
    if (!unit) return { ok: false, error: "not_found" } as const;
    const [inHouse] = await tx
      .select({ id: schema.reservations.id })
      .from(schema.reservations)
      .where(and(eq(schema.reservations.unitId, unit.id), eq(schema.reservations.status, "in_house")))
      .limit(1);
    if (inHouse) return { ok: false, error: "occupied" } as const;
    const from = await unitState(tx, unit.id);
    if (!canTransition(from, input.to)) return { ok: false, error: "invalid_transition" } as const;
    await recordState(tx, unit.id, from, input.to, input.actor, input.note?.trim().slice(0, 500) || null, now);
    return { ok: true } as const;
  });
}

/**
 * Takes a unit out of sale for [startDate, endDate). Refused when confirmed,
 * in-house or held bookings use those nights: move them first.
 */
export async function createBlock(
  db: AnyDb,
  input: { unitId: string; startDate: string; endDate: string; reason: string; actor: Actor; now?: Date },
): Promise<HkResult> {
  const now = input.now ?? new Date();
  const reason = input.reason.trim().slice(0, 300);
  if (!isIsoDate(input.startDate) || !isIsoDate(input.endDate) || input.endDate <= input.startDate || !reason) {
    return { ok: false, error: "invalid_dates" };
  }
  return db.transaction(async (tx) => {
    const unit = await lockUnit(tx, input.unitId);
    if (!unit) return { ok: false, error: "not_found" } as const;
    if (input.startDate < todayIn(unit.timezone, now)) return { ok: false, error: "invalid_dates" } as const;
    const conflicts = await tx
      .select({ code: schema.reservations.code })
      .from(schema.reservations)
      .where(
        and(
          eq(schema.reservations.unitId, unit.id),
          sql`daterange(${schema.reservations.checkIn}, ${schema.reservations.checkOut}, '[)') && daterange(${input.startDate}::date, ${input.endDate}::date, '[)')`,
          sql`(${inArray(schema.reservations.status, ["confirmed", "in_house"])} OR (${schema.reservations.status} = 'hold' AND ${schema.reservations.holdExpiresAt} > ${now.toISOString()}::timestamptz))`,
        ),
      );
    if (conflicts.length) return { ok: false, error: "conflicts_with_bookings", codes: conflicts.map((c) => c.code) } as const;
    try {
      await tx.transaction(async (sp) => {
        await sp.insert(schema.unitBlocks).values({
          unitId: unit.id,
          startDate: input.startDate,
          endDate: input.endDate,
          reason,
          createdBy: input.actor.id ?? input.actor.type,
          createdAt: now,
          updatedAt: now,
        });
      });
    } catch (error) {
      let current: unknown = error;
      while (current && typeof current === "object") {
        if ("code" in current && current.code === "23P01") return { ok: false, error: "overlaps_block" } as const;
        current = "cause" in current ? current.cause : undefined;
      }
      throw error;
    }
    await tx.insert(schema.auditEvents).values({
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      propertyId: unit.propertyId,
      entityType: "unit",
      entityId: unit.id,
      action: "unit.blocked",
      after: { startDate: input.startDate, endDate: input.endDate, reason },
      occurredAt: now,
    });
    return { ok: true } as const;
  });
}

/**
 * Ends a block. A unit coming back from maintenance needs an inspection
 * before it can be sold or checked into again.
 */
export async function resolveBlock(db: AnyDb, input: { blockId: string; actor: Actor; now?: Date }): Promise<HkResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [block] = await tx.select().from(schema.unitBlocks).where(eq(schema.unitBlocks.id, input.blockId)).for("update");
    if (!block) return { ok: false, error: "not_found" } as const;
    if (block.status !== "open") return { ok: false, error: "already_resolved" } as const;
    const unit = await lockUnit(tx, block.unitId);
    await tx
      .update(schema.unitBlocks)
      .set({ status: "resolved", resolvedBy: input.actor.id ?? input.actor.type, resolvedAt: now, updatedAt: now })
      .where(eq(schema.unitBlocks.id, block.id));
    const from = await unitState(tx, block.unitId);
    // A dirty unit stays dirty (it still needs cleaning); a ready one must be re-inspected.
    // The note is the reason staff wrote (in their own language), not fixed English text.
    if (from === "ready") await recordState(tx, block.unitId, from, "inspect", input.actor, block.reason, now);
    await tx.insert(schema.auditEvents).values({
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      propertyId: unit?.propertyId ?? null,
      entityType: "unit",
      entityId: block.unitId,
      action: "unit.unblocked",
      before: { blockId: block.id, reason: block.reason },
      occurredAt: now,
    });
    return { ok: true } as const;
  });
}
