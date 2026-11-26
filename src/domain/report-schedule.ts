import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { addDays } from "./dates";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Actor = { type: "staff"; id: string };

/*
 * Scheduled reports (rules agreed with the owner, 26 Nov 2026):
 * - daily, every morning: yesterday's figures and today's movements;
 * - weekly, on Monday: the last 7 days and the pace of the coming months,
 *   with Excel files;
 * - monthly, on the 1st: last month in full, with an Excel file.
 * Reports go out from SEND_HOUR local time, once per property and period, by
 * email to the recipients the branch manager chose (staff or other
 * addresses). Without email keys they wait, and are skipped after a few days.
 */

export const REPORT_KINDS = schema.REPORT_KINDS;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const SEND_HOUR = 7;
const KEEP_TRYING_DAYS = 3;
const MAX_ATTEMPTS = 5;

/** Local date and time, "YYYY-MM-DDTHH:MM". */
function localNow(timeZone: string, now: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export type ReportPeriod = { kind: ReportKind; periodKey: string; from: string; to: string; today: string };

/** The period a report covers, given the day it is sent ("today" at the property). */
export function reportPeriod(kind: ReportKind, today: string): ReportPeriod {
  if (kind === "daily") return { kind, periodKey: today, from: addDays(today, -1), to: addDays(today, -1), today };
  if (kind === "weekly") return { kind, periodKey: today, from: addDays(today, -7), to: addDays(today, -1), today };
  const lastDay = addDays(`${today.slice(0, 7)}-01`, -1);
  return { kind, periodKey: lastDay.slice(0, 7), from: `${lastDay.slice(0, 7)}-01`, to: lastDay, today };
}

/** Reports due at this local time: daily every day, weekly on Monday, monthly on the 1st, from SEND_HOUR. */
export function duePeriods(local: string): ReportPeriod[] {
  const [today, time] = local.split("T");
  if (Number(time.slice(0, 2)) < SEND_HOUR) return [];
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const due: ReportKind[] = ["daily", ...(weekday === 1 ? (["weekly"] as const) : []), ...(today.endsWith("-01") ? (["monthly"] as const) : [])];
  return due.map((k) => reportPeriod(k, today));
}

const validEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;

export type ScheduleError = "invalid" | "not_found" | "duplicate" | "not_eligible";

/** Adds a recipient: a director or branch manager of the property, or another email address. */
export async function addSubscription(
  db: AnyDb,
  input: { propertyId: string; kind: string; staffId?: string | null; email?: string | null; locale?: string; actor: Actor },
): Promise<{ ok: true } | { ok: false; error: ScheduleError }> {
  if (!(REPORT_KINDS as readonly string[]).includes(input.kind)) return { ok: false, error: "invalid" };
  const email = input.email?.trim().toLowerCase() || null;
  const staffId = input.staffId || null;
  if ((email === null) === (staffId === null) || (email && !validEmail(email))) return { ok: false, error: "invalid" };
  const locale = input.locale === "en" ? "en" : "id";
  if (staffId) {
    const [member] = await db.select().from(schema.staffMembers).where(eq(schema.staffMembers.id, staffId));
    if (!member || !member.isActive) return { ok: false, error: "not_found" };
    const access = await db
      .select({ id: schema.staffPropertyAccess.staffId })
      .from(schema.staffPropertyAccess)
      .where(and(eq(schema.staffPropertyAccess.staffId, staffId), eq(schema.staffPropertyAccess.propertyId, input.propertyId)));
    if (!(member.role === "director" || (member.role === "branch_manager" && access.length))) return { ok: false, error: "not_eligible" };
  }
  const inserted = await db
    .insert(schema.reportSubscriptions)
    .values({ propertyId: input.propertyId, kind: input.kind, staffId, email, locale, createdBy: input.actor.id })
    .onConflictDoNothing()
    .returning({ id: schema.reportSubscriptions.id });
  if (!inserted.length) return { ok: false, error: "duplicate" };
  // The address itself stays out of the log.
  await db.insert(schema.auditEvents).values({ actorType: "staff", actorId: input.actor.id, propertyId: input.propertyId, entityType: "property", entityId: input.propertyId, action: "report.recipient_added", after: { kind: input.kind, staff: Boolean(staffId) }, occurredAt: new Date() });
  return { ok: true };
}

export async function removeSubscription(db: AnyDb, input: { subscriptionId: string; actor: Actor }): Promise<{ ok: true } | { ok: false; error: ScheduleError }> {
  const deleted = await db.delete(schema.reportSubscriptions).where(eq(schema.reportSubscriptions.id, input.subscriptionId)).returning({ propertyId: schema.reportSubscriptions.propertyId, kind: schema.reportSubscriptions.kind });
  if (!deleted.length) return { ok: false, error: "not_found" };
  await db.insert(schema.auditEvents).values({ actorType: "staff", actorId: input.actor.id, propertyId: deleted[0].propertyId, entityType: "property", entityId: deleted[0].propertyId, action: "report.recipient_removed", after: { kind: deleted[0].kind }, occurredAt: new Date() });
  return { ok: true };
}

/** Where a report goes: each recipient's address and language (inactive staff are left out). */
export async function recipientsFor(db: AnyDb, propertyId: string, kind: string) {
  const rows = await db
    .select({ email: schema.reportSubscriptions.email, staffEmail: schema.staffMembers.email, staffActive: schema.staffMembers.isActive, locale: schema.reportSubscriptions.locale })
    .from(schema.reportSubscriptions)
    .leftJoin(schema.staffMembers, eq(schema.staffMembers.id, schema.reportSubscriptions.staffId))
    .where(and(eq(schema.reportSubscriptions.propertyId, propertyId), eq(schema.reportSubscriptions.kind, kind)));
  const out = new Map<string, "id" | "en">();
  for (const r of rows) {
    const address = r.email ?? (r.staffActive ? r.staffEmail : null);
    if (address) out.set(address.toLowerCase(), r.locale === "en" ? "en" : "id");
  }
  return [...out].map(([email, locale]) => ({ email, locale }));
}

/** Records the runs now due for every property with recipients (once per period). Returns how many were added. */
export async function queueDueReports(db: AnyDb, now: Date = new Date()): Promise<number> {
  const subscribed = await db
    .selectDistinct({ propertyId: schema.reportSubscriptions.propertyId, kind: schema.reportSubscriptions.kind, timezone: schema.properties.timezone })
    .from(schema.reportSubscriptions)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reportSubscriptions.propertyId))
    .where(eq(schema.properties.isActive, true));
  let added = 0;
  for (const s of subscribed) {
    const period = duePeriods(localNow(s.timezone, now)).find((p) => p.kind === s.kind);
    if (!period) continue;
    const rows = await db
      .insert(schema.reportRuns)
      .values({ propertyId: s.propertyId, kind: s.kind, periodKey: period.periodKey, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning({ id: schema.reportRuns.id });
    added += rows.length;
  }
  return added;
}

/** Runs waiting to be sent. Runs that could not go out within a few days are skipped (stale figures help nobody). */
export async function pendingRuns(db: AnyDb, now: Date = new Date(), limit = 20) {
  const cutoff = new Date(now.getTime() - KEEP_TRYING_DAYS * 86_400_000);
  await db
    .update(schema.reportRuns)
    .set({ status: "skipped", updatedAt: now })
    .where(and(eq(schema.reportRuns.status, "pending"), lt(schema.reportRuns.createdAt, cutoff)));
  return db
    .select({ run: schema.reportRuns, property: schema.properties })
    .from(schema.reportRuns)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reportRuns.propertyId))
    .where(and(eq(schema.reportRuns.status, "pending"), lt(schema.reportRuns.attempts, MAX_ATTEMPTS)))
    .orderBy(asc(schema.reportRuns.createdAt))
    .limit(limit);
}

/** Records the outcome of an attempt: sent, or failed (retried until MAX_ATTEMPTS unless permanent). */
export async function finishRun(db: AnyDb, input: { runId: string; ok: boolean; recipients: number; error?: string | null; permanent?: boolean; now?: Date }) {
  const now = input.now ?? new Date();
  await db
    .update(schema.reportRuns)
    .set(
      input.ok
        ? { status: "sent", recipients: input.recipients, sentAt: now, lastError: null, attempts: sql`${schema.reportRuns.attempts} + 1`, updatedAt: now }
        : {
            status: sql`CASE WHEN ${input.permanent ?? false} OR ${schema.reportRuns.attempts} + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END`,
            lastError: (input.error ?? "").slice(0, 500),
            attempts: sql`${schema.reportRuns.attempts} + 1`,
            updatedAt: now,
          },
    )
    .where(eq(schema.reportRuns.id, input.runId));
}

/** Recent runs of a property, newest first (for the schedule page). */
export async function recentRuns(db: AnyDb, propertyIds: string[], limit = 15) {
  if (!propertyIds.length) return [];
  return db
    .select()
    .from(schema.reportRuns)
    .where(inArray(schema.reportRuns.propertyId, propertyIds))
    .orderBy(sql`${schema.reportRuns.createdAt} DESC`)
    .limit(limit);
}
