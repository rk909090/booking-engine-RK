import { and, asc, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { EXCLUSION_VIOLATION, sqlState } from "./booking";
import { addDays, diffDays, isIsoDate } from "./dates";
import { applyBp } from "./pricing";
import { netNights } from "./reports";
import { EXPENSE_CATEGORIES, type CommissionRates, type OwnerStatementData } from "./types";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Tx = Parameters<Parameters<AnyDb["transaction"]>[0]>[0];
type Executor = AnyDb | Tx;
type Actor = { type: "staff"; id: string };

/*
 * Villa owners and their monthly statements (rules agreed with the owner,
 * 26 Nov 2026):
 * - each villa has one owner at a time (with history, so a sale mid-month
 *   splits the month);
 * - room revenue is counted per night stayed, net of discount, without tax
 *   and service (the same figure as the reports);
 * - channel commission (per booking source) comes off first, then the
 *   management fee is the agreed share of what remains;
 * - expenses are then deducted: entered by staff, monthly recurring costs
 *   (prorated by days owned) and the cost of finished maintenance tickets;
 * - a branch manager locks a finished month: the figures are frozen, that
 *   month can no longer be changed for that owner, and the payout is recorded.
 */

export type OwnersError =
  | "not_found"
  | "invalid"
  | "dates"
  | "overlap"
  | "month_locked"
  | "no_owner"
  | "month_not_over"
  | "already_locked"
  | "already_paid";
export type OwnersResult = { ok: true; id?: string } | { ok: false; error: OwnersError };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** "2026-11" → "2026-11-01"; null when not a month. */
export function monthStart(month: string): string | null {
  return MONTH.test(month) ? `${month}-01` : null;
}
export function nextMonth(first: string): string {
  const [y, m] = first.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
export function monthOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

const validName = (s: string) => s.length >= 2 && s.length <= 120;
const validEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

async function audit(db: Executor, actor: Actor, propertyId: string | null, entityType: string, entityId: string, action: string, after: Record<string, unknown>) {
  await db.insert(schema.auditEvents).values({ actorType: actor.type, actorId: actor.id, propertyId, entityType, entityId, action, after, occurredAt: new Date() });
}

export async function createOwner(db: AnyDb, input: { fullName: string; email?: string | null; phone?: string | null; note?: string | null; actor: Actor }): Promise<OwnersResult> {
  const fullName = input.fullName.trim().replace(/\s+/g, " ");
  const email = input.email?.trim().toLowerCase() || null;
  if (!validName(fullName) || (email && !validEmail(email))) return { ok: false, error: "invalid" };
  const [row] = await db
    .insert(schema.owners)
    .values({ fullName, email, phone: input.phone?.trim().slice(0, 40) || null, note: input.note?.trim().slice(0, 300) || null, createdBy: input.actor.id })
    .returning({ id: schema.owners.id });
  // No contact details in the log.
  await audit(db, input.actor, null, "owner", row.id, "owner.created", {});
  return { ok: true, id: row.id };
}

export async function updateOwner(db: AnyDb, input: { ownerId: string; fullName: string; email?: string | null; phone?: string | null; note?: string | null; actor: Actor }): Promise<OwnersResult> {
  const fullName = input.fullName.trim().replace(/\s+/g, " ");
  const email = input.email?.trim().toLowerCase() || null;
  if (!validName(fullName) || (email && !validEmail(email))) return { ok: false, error: "invalid" };
  const updated = await db
    .update(schema.owners)
    .set({ fullName, email, phone: input.phone?.trim().slice(0, 40) || null, note: input.note?.trim().slice(0, 300) || null, updatedAt: new Date() })
    .where(eq(schema.owners.id, input.ownerId))
    .returning({ id: schema.owners.id });
  if (!updated.length) return { ok: false, error: "not_found" };
  await audit(db, input.actor, null, "owner", input.ownerId, "owner.updated", {});
  return { ok: true };
}

/** The ownership of a villa on a date. */
async function ownershipOn(db: Executor, unitId: string, date: string) {
  const [row] = await db
    .select()
    .from(schema.unitOwnerships)
    .where(
      and(
        eq(schema.unitOwnerships.unitId, unitId),
        sql`${schema.unitOwnerships.startDate} <= ${date}::date`,
        or(isNull(schema.unitOwnerships.endDate), sql`${schema.unitOwnerships.endDate} > ${date}::date`),
      ),
    );
  return row ?? null;
}

/** Whether a locked statement of the property, for `from`'s month or later, covers this villa. */
async function lockedFrom(db: Executor, propertyId: string, unitId: string, from: string) {
  const rows = await db
    .select({ data: schema.ownerStatements.data })
    .from(schema.ownerStatements)
    .where(and(eq(schema.ownerStatements.propertyId, propertyId), gte(schema.ownerStatements.month, monthOf(from))));
  return rows.some((r) => r.data.units.some((u) => u.unitId === unitId));
}

/** Whether the month of `date` is locked for whoever owned the villa then. */
async function lockedOn(db: Executor, propertyId: string, unitId: string, date: string) {
  const own = await ownershipOn(db, unitId, date);
  if (!own) return { owner: null, locked: false };
  const [st] = await db
    .select({ id: schema.ownerStatements.id })
    .from(schema.ownerStatements)
    .where(and(eq(schema.ownerStatements.ownerId, own.ownerId), eq(schema.ownerStatements.propertyId, propertyId), eq(schema.ownerStatements.month, monthOf(date))));
  return { owner: own, locked: Boolean(st) };
}

async function unitRow(db: Executor, unitId: string) {
  const [u] = await db.select().from(schema.units).where(eq(schema.units.id, unitId));
  return u ?? null;
}

/**
 * Gives a villa to an owner from `startDate`, ending the previous owner's
 * period that day. Only forward from the villa's latest ownership, and never
 * into a locked month.
 */
export async function assignUnit(db: AnyDb, input: { unitId: string; ownerId: string; startDate: string; feeBp: number; actor: Actor }): Promise<OwnersResult> {
  if (!isIsoDate(input.startDate)) return { ok: false, error: "dates" };
  if (!Number.isInteger(input.feeBp) || input.feeBp < 0 || input.feeBp > 10_000) return { ok: false, error: "invalid" };
  const unit = await unitRow(db, input.unitId);
  const [owner] = await db.select({ id: schema.owners.id }).from(schema.owners).where(eq(schema.owners.id, input.ownerId));
  if (!unit || !owner) return { ok: false, error: "not_found" };
  if (await lockedFrom(db, unit.propertyId, unit.id, input.startDate)) return { ok: false, error: "month_locked" };
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM ${schema.units} WHERE id = ${unit.id} FOR UPDATE`);
      const [latest] = await tx.select().from(schema.unitOwnerships).where(eq(schema.unitOwnerships.unitId, unit.id)).orderBy(sql`${schema.unitOwnerships.startDate} DESC`).limit(1);
      if (latest && latest.startDate >= input.startDate) return { ok: false, error: "dates" } as const;
      if (latest && (latest.endDate === null || latest.endDate > input.startDate)) {
        await tx.update(schema.unitOwnerships).set({ endDate: input.startDate, updatedAt: new Date() }).where(eq(schema.unitOwnerships.id, latest.id));
      }
      const [row] = await tx
        .insert(schema.unitOwnerships)
        .values({ unitId: unit.id, ownerId: owner.id, startDate: input.startDate, managementFeeBp: input.feeBp, createdBy: input.actor.id })
        .returning({ id: schema.unitOwnerships.id });
      await audit(tx, input.actor, unit.propertyId, "unit", unit.id, "owner.unit_assigned", { ownerId: owner.id, startDate: input.startDate, feeBp: input.feeBp, previous: latest?.id ?? null });
      return { ok: true, id: row.id } as const;
    });
  } catch (error) {
    if (sqlState(error) === EXCLUSION_VIOLATION) return { ok: false, error: "overlap" };
    throw error;
  }
}

/** Ends an owner's period on a villa (the villa then has no owner from that date). */
export async function endOwnership(db: AnyDb, input: { ownershipId: string; endDate: string; actor: Actor }): Promise<OwnersResult> {
  const [own] = await db.select().from(schema.unitOwnerships).where(eq(schema.unitOwnerships.id, input.ownershipId));
  if (!own) return { ok: false, error: "not_found" };
  if (!isIsoDate(input.endDate) || input.endDate <= own.startDate || (own.endDate !== null && input.endDate >= own.endDate)) return { ok: false, error: "dates" };
  const unit = await unitRow(db, own.unitId);
  if (!unit) return { ok: false, error: "not_found" };
  if (await lockedFrom(db, unit.propertyId, unit.id, input.endDate)) return { ok: false, error: "month_locked" };
  await db.update(schema.unitOwnerships).set({ endDate: input.endDate, updatedAt: new Date() }).where(eq(schema.unitOwnerships.id, own.id));
  await audit(db, input.actor, unit.propertyId, "unit", unit.id, "owner.unit_ended", { ownershipId: own.id, endDate: input.endDate });
  return { ok: true };
}

export const COMMISSION_SOURCES = ["ota", "agent", "website", "direct", "walk_in"] as const;

/** Channel commission by booking source, in basis points of room revenue. */
export async function setCommissionRates(db: AnyDb, input: { propertyId: string; rates: CommissionRates; actor: Actor }): Promise<OwnersResult> {
  const rates: CommissionRates = {};
  for (const [source, bp] of Object.entries(input.rates)) {
    if (!(COMMISSION_SOURCES as readonly string[]).includes(source)) return { ok: false, error: "invalid" };
    if (bp === undefined || bp === 0) continue;
    if (!Number.isInteger(bp) || bp < 0 || bp > 5000) return { ok: false, error: "invalid" };
    rates[source as keyof CommissionRates] = bp;
  }
  const updated = await db.update(schema.properties).set({ commissionRates: rates, updatedAt: new Date() }).where(eq(schema.properties.id, input.propertyId)).returning({ id: schema.properties.id });
  if (!updated.length) return { ok: false, error: "not_found" };
  await audit(db, input.actor, input.propertyId, "property", input.propertyId, "owner.commission_rates_set", { rates });
  return { ok: true };
}

type ExpenseInput = {
  unitId: string;
  date: string;
  category: string;
  description: string;
  amount: number;
  actor: Actor;
  source?: "manual" | "maintenance";
  taskId?: string | null;
};

/** Checks an expense; the caller inserts it (alone, or with a finished maintenance ticket). */
export async function checkExpense(db: Executor, input: ExpenseInput): Promise<{ ok: true; propertyId: string } | { ok: false; error: OwnersError }> {
  if (!isIsoDate(input.date)) return { ok: false, error: "dates" };
  const description = input.description.trim();
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(input.category) || !description) return { ok: false, error: "invalid" };
  if (!Number.isSafeInteger(input.amount) || input.amount === 0 || (input.amount < 0 && input.category !== "adjustment") || Math.abs(input.amount) > 10_000_000_000) {
    return { ok: false, error: "invalid" };
  }
  const unit = await unitRow(db, input.unitId);
  if (!unit) return { ok: false, error: "not_found" };
  const { owner, locked } = await lockedOn(db, unit.propertyId, unit.id, input.date);
  if (!owner) return { ok: false, error: "no_owner" };
  if (locked) return { ok: false, error: "month_locked" };
  return { ok: true, propertyId: unit.propertyId };
}

export async function insertExpense(db: Executor, input: ExpenseInput, propertyId: string): Promise<string> {
  const [row] = await db
    .insert(schema.ownerExpenses)
    .values({
      propertyId,
      unitId: input.unitId,
      expenseDate: input.date,
      category: input.category,
      description: input.description.trim().slice(0, 200),
      amount: input.amount,
      source: input.source ?? "manual",
      taskId: input.taskId ?? null,
      createdBy: input.actor.id,
    })
    .returning({ id: schema.ownerExpenses.id });
  await audit(db, input.actor, propertyId, "unit", input.unitId, "owner.expense_added", { expenseId: row.id, date: input.date, category: input.category, amount: input.amount, source: input.source ?? "manual" });
  return row.id;
}

/** An expense charged to the villa's owner of that date. Refused once that owner's month is locked. */
export async function addExpense(db: AnyDb, input: ExpenseInput): Promise<OwnersResult> {
  const checked = await checkExpense(db, input);
  if (!checked.ok) return checked;
  return { ok: true, id: await insertExpense(db, input, checked.propertyId) };
}

export async function voidExpense(db: AnyDb, input: { expenseId: string; reason: string; actor: Actor }): Promise<OwnersResult> {
  const [e] = await db.select().from(schema.ownerExpenses).where(eq(schema.ownerExpenses.id, input.expenseId));
  if (!e || e.voidedAt) return { ok: false, error: "not_found" };
  const reason = input.reason.trim().slice(0, 200);
  if (!reason) return { ok: false, error: "invalid" };
  if ((await lockedOn(db, e.propertyId, e.unitId, e.expenseDate)).locked) return { ok: false, error: "month_locked" };
  await db.update(schema.ownerExpenses).set({ voidedAt: new Date(), voidedBy: input.actor.id, voidReason: reason, updatedAt: new Date() }).where(eq(schema.ownerExpenses.id, e.id));
  await audit(db, input.actor, e.propertyId, "unit", e.unitId, "owner.expense_voided", { expenseId: e.id, reason });
  return { ok: true };
}

/** A cost charged every month from `startMonth` ("2026-12"), until stopped. */
export async function addRecurring(db: AnyDb, input: { unitId: string; category: string; description: string; amount: number; startMonth: string; actor: Actor }): Promise<OwnersResult> {
  const start = monthStart(input.startMonth);
  if (!start) return { ok: false, error: "dates" };
  const description = input.description.trim();
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(input.category) || input.category === "adjustment" || !description) return { ok: false, error: "invalid" };
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > 10_000_000_000) return { ok: false, error: "invalid" };
  const unit = await unitRow(db, input.unitId);
  if (!unit) return { ok: false, error: "not_found" };
  if (await lockedFrom(db, unit.propertyId, unit.id, start)) return { ok: false, error: "month_locked" };
  const [row] = await db
    .insert(schema.recurringExpenses)
    .values({ propertyId: unit.propertyId, unitId: unit.id, category: input.category, description: description.slice(0, 200), amount: input.amount, startMonth: start, createdBy: input.actor.id })
    .returning({ id: schema.recurringExpenses.id });
  await audit(db, input.actor, unit.propertyId, "unit", unit.id, "owner.recurring_added", { recurringId: row.id, category: input.category, amount: input.amount, startMonth: start });
  return { ok: true, id: row.id };
}

/** Stops a recurring cost after `lastMonth` ("2027-03", charged that month for the last time). */
export async function stopRecurring(db: AnyDb, input: { recurringId: string; lastMonth: string; actor: Actor }): Promise<OwnersResult> {
  const last = monthStart(input.lastMonth);
  const [r] = await db.select().from(schema.recurringExpenses).where(eq(schema.recurringExpenses.id, input.recurringId));
  if (!r) return { ok: false, error: "not_found" };
  if (!last || last < addDays(r.startMonth, -1).slice(0, 7) + "-01" || (r.endMonth !== null && last >= r.endMonth)) return { ok: false, error: "dates" };
  // A month before the start means "never charged"; it must not reach into a locked month.
  if (await lockedFrom(db, r.propertyId, r.unitId, nextMonth(last))) return { ok: false, error: "month_locked" };
  if (last < r.startMonth) {
    await db.delete(schema.recurringExpenses).where(eq(schema.recurringExpenses.id, r.id));
  } else {
    await db.update(schema.recurringExpenses).set({ endMonth: last, updatedAt: new Date() }).where(eq(schema.recurringExpenses.id, r.id));
  }
  await audit(db, input.actor, r.propertyId, "unit", r.unitId, "owner.recurring_stopped", { recurringId: r.id, lastMonth: last });
  return { ok: true };
}

export type StatementRow = {
  ownerId: string;
  status: "draft" | "locked" | "paid";
  statementId: string | null;
  paidAt: Date | null;
  paidReference: string | null;
  data: OwnerStatementData;
};

/**
 * Every owner's statement for a property and month: locked ones as frozen,
 * the others computed from the current bookings and expenses.
 */
export async function buildStatements(db: Executor, input: { propertyId: string; month: string }): Promise<StatementRow[] | null> {
  const first = monthStart(input.month);
  if (!first) return null;
  const next = nextMonth(first);
  const daysInMonth = diffDays(first, next);
  const [property] = await db.select().from(schema.properties).where(eq(schema.properties.id, input.propertyId));
  if (!property) return null;

  const owned = await db
    .select({ own: schema.unitOwnerships, owner: schema.owners, code: schema.units.code, typeName: schema.unitTypes.name })
    .from(schema.unitOwnerships)
    .innerJoin(schema.units, eq(schema.units.id, schema.unitOwnerships.unitId))
    .innerJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.units.unitTypeId))
    .innerJoin(schema.owners, eq(schema.owners.id, schema.unitOwnerships.ownerId))
    .where(
      and(
        eq(schema.units.propertyId, property.id),
        lt(schema.unitOwnerships.startDate, next),
        or(isNull(schema.unitOwnerships.endDate), gt(schema.unitOwnerships.endDate, first)),
      ),
    )
    .orderBy(asc(schema.units.code), asc(schema.unitOwnerships.startDate));
  const unitIds = [...new Set(owned.map((o) => o.own.unitId))];

  const stays = unitIds.length
    ? await db
        .select({
          code: schema.reservations.code,
          unitId: schema.reservations.unitId,
          source: schema.reservations.source,
          checkIn: schema.reservations.checkIn,
          checkOut: schema.reservations.checkOut,
          priceSnapshot: schema.reservations.priceSnapshot,
          subtotalAmount: schema.reservations.subtotalAmount,
          discountAmount: schema.reservations.discountAmount,
        })
        .from(schema.reservations)
        .where(
          and(
            inArray(schema.reservations.unitId, unitIds),
            inArray(schema.reservations.status, ["confirmed", "in_house", "checked_out"]),
            lt(schema.reservations.checkIn, next),
            gt(schema.reservations.checkOut, first),
          ),
        )
        .orderBy(asc(schema.reservations.checkIn))
    : [];
  const expenses = unitIds.length
    ? await db
        .select()
        .from(schema.ownerExpenses)
        .where(and(inArray(schema.ownerExpenses.unitId, unitIds), isNull(schema.ownerExpenses.voidedAt), gte(schema.ownerExpenses.expenseDate, first), lt(schema.ownerExpenses.expenseDate, next)))
        .orderBy(asc(schema.ownerExpenses.expenseDate))
    : [];
  const recurring = unitIds.length
    ? await db
        .select()
        .from(schema.recurringExpenses)
        .where(
          and(
            inArray(schema.recurringExpenses.unitId, unitIds),
            sql`${schema.recurringExpenses.startMonth} <= ${first}::date`,
            or(isNull(schema.recurringExpenses.endMonth), sql`${schema.recurringExpenses.endMonth} >= ${first}::date`),
          ),
        )
    : [];
  const rates = property.commissionRates;

  const byOwner = new Map<string, OwnerStatementData>();
  for (const { own, owner, code, typeName } of owned) {
    const from = own.startDate > first ? own.startDate : first;
    const to = own.endDate && own.endDate < next ? own.endDate : next;
    const ownedNights = diffDays(from, to);
    const inPeriod = (d: string) => d >= from && d < to;
    const unitStays: OwnerStatementData["units"][number]["stays"] = [];
    for (const r of stays.filter((s) => s.unitId === own.unitId)) {
      const nights = netNights(r).filter((n) => inPeriod(n.date));
      if (!nights.length) continue;
      const revenue = nights.reduce((sum, n) => sum + n.net, 0);
      unitStays.push({ code: r.code, source: r.source, checkIn: r.checkIn, checkOut: r.checkOut, nights: nights.length, revenue, commission: applyBp(revenue, rates[r.source as keyof CommissionRates] ?? 0) });
    }
    const unitExpenses: OwnerStatementData["units"][number]["expenses"] = [
      ...recurring
        .filter((x) => x.unitId === own.unitId)
        .map((x) => ({
          date: from,
          category: x.category,
          description: x.description,
          // Prorated by the days this owner had the villa in the month.
          amount: ownedNights === daysInMonth ? x.amount : Math.round((x.amount * ownedNights) / daysInMonth),
          source: "recurring" as const,
        })),
      ...expenses
        .filter((x) => x.unitId === own.unitId && inPeriod(x.expenseDate))
        .map((x) => ({ date: x.expenseDate, category: x.category, description: x.description, amount: x.amount, source: x.source as "manual" | "maintenance" })),
    ];
    const roomRevenue = unitStays.reduce((s, x) => s + x.revenue, 0);
    const commission = unitStays.reduce((s, x) => s + x.commission, 0);
    const fee = applyBp(roomRevenue - commission, own.managementFeeBp);
    const expenseTotal = unitExpenses.reduce((s, x) => s + x.amount, 0);
    const data =
      byOwner.get(owner.id) ??
      ({
        owner: { fullName: owner.fullName, email: owner.email },
        property: { name: property.name, slug: property.slug },
        month: first,
        units: [],
        totals: { ownedNights: 0, soldNights: 0, roomRevenue: 0, commission: 0, fee: 0, expenses: 0, payout: 0 },
      } satisfies OwnerStatementData);
    const soldNights = unitStays.reduce((s, x) => s + x.nights, 0);
    const payout = roomRevenue - commission - fee - expenseTotal;
    data.units.push({ unitId: own.unitId, code, typeName, feeBp: own.managementFeeBp, ownedNights, soldNights, roomRevenue, commission, fee, expenses: unitExpenses, expenseTotal, payout, stays: unitStays });
    const t = data.totals;
    t.ownedNights += ownedNights;
    t.soldNights += soldNights;
    t.roomRevenue += roomRevenue;
    t.commission += commission;
    t.fee += fee;
    t.expenses += expenseTotal;
    t.payout += payout;
    byOwner.set(owner.id, data);
  }

  const locked = await db.select().from(schema.ownerStatements).where(and(eq(schema.ownerStatements.propertyId, property.id), eq(schema.ownerStatements.month, first)));
  const rows: StatementRow[] = locked.map((s) => ({ ownerId: s.ownerId, status: s.status as "locked" | "paid", statementId: s.id, paidAt: s.paidAt, paidReference: s.paidReference, data: s.data }));
  for (const [ownerId, data] of byOwner) {
    if (!locked.some((s) => s.ownerId === ownerId)) rows.push({ ownerId, status: "draft", statementId: null, paidAt: null, paidReference: null, data });
  }
  return rows.sort((a, b) => a.data.owner.fullName.localeCompare(b.data.owner.fullName));
}

/** Freezes an owner's statement for a month that has ended. */
export async function lockStatement(db: AnyDb, input: { ownerId: string; propertyId: string; month: string; today: string; actor: Actor; now?: Date }): Promise<OwnersResult> {
  const first = monthStart(input.month);
  if (!first) return { ok: false, error: "dates" };
  if (nextMonth(first) > input.today) return { ok: false, error: "month_not_over" };
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const rows = await buildStatements(tx, { propertyId: input.propertyId, month: input.month });
    const row = rows?.find((r) => r.ownerId === input.ownerId);
    if (!row) return { ok: false, error: "not_found" } as const;
    if (row.status !== "draft") return { ok: false, error: "already_locked" } as const;
    const t = row.data.totals;
    const inserted = await tx
      .insert(schema.ownerStatements)
      .values({ ownerId: input.ownerId, propertyId: input.propertyId, month: first, roomRevenue: t.roomRevenue, commission: t.commission, managementFee: t.fee, expenses: t.expenses, payout: t.payout, data: row.data, lockedAt: now, lockedBy: input.actor.id })
      .onConflictDoNothing()
      .returning({ id: schema.ownerStatements.id });
    if (!inserted.length) return { ok: false, error: "already_locked" } as const;
    await audit(tx, input.actor, input.propertyId, "owner_statement", inserted[0].id, "owner.statement_locked", { ownerId: input.ownerId, month: first, payout: t.payout });
    return { ok: true, id: inserted[0].id } as const;
  });
}

/** Records that the owner was paid (or paid what they owed) for a locked statement. */
export async function markStatementPaid(db: AnyDb, input: { statementId: string; reference: string; actor: Actor; now?: Date }): Promise<OwnersResult> {
  const now = input.now ?? new Date();
  const reference = input.reference.trim().slice(0, 200);
  if (!reference) return { ok: false, error: "invalid" };
  const updated = await db
    .update(schema.ownerStatements)
    .set({ status: "paid", paidAt: now, paidBy: input.actor.id, paidReference: reference, updatedAt: now })
    .where(and(eq(schema.ownerStatements.id, input.statementId), eq(schema.ownerStatements.status, "locked")))
    .returning({ id: schema.ownerStatements.id, propertyId: schema.ownerStatements.propertyId });
  if (!updated.length) {
    const [s] = await db.select({ status: schema.ownerStatements.status }).from(schema.ownerStatements).where(eq(schema.ownerStatements.id, input.statementId));
    return { ok: false, error: s ? "already_paid" : "not_found" };
  }
  await audit(db, input.actor, updated[0].propertyId, "owner_statement", input.statementId, "owner.statement_paid", { reference });
  return { ok: true };
}
