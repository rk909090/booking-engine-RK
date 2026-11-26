import "server-only";
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { brand } from "@/config/brand";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { addDays, todayIn } from "@/domain/dates";
import { calendarConflicts } from "@/domain/ical";
import { ratios } from "@/domain/reports";
import { taskBoard, urgency } from "@/domain/tasks";
import { can, type Actor } from "@/lib/authz/permissions";
import { todayCounts, villaStatus, visibleProperties } from "./queries";
import { buildReport } from "./reports";

/*
 * Figures for the staff home page: what needs doing today first (arrivals,
 * departures, requests, overdue money, villas not ready, late tasks), then
 * how the coming week and the month look. Each block is only loaded for
 * roles that may see it.
 */

const FORWARD_NIGHTS = 14;

export async function dashboardData(actor: Actor, input: { property?: string; now?: Date }) {
  const db = getDb();
  const now = input.now ?? new Date();
  const properties = await visibleProperties(actor);
  const selected = properties.find((p) => p.slug === input.property) ?? null;
  const propertyIds = selected ? [selected.id] : properties.map((p) => p.id);
  const today = todayIn(selected?.timezone ?? brand.timezone, now);
  const nowTime = new Intl.DateTimeFormat("en-GB", { timeZone: selected?.timezone ?? brand.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const sees = {
    reservations: can(actor, "reservation.view").allowed,
    villas: can(actor, "villa_status.view").allowed,
    tasks: can(actor, "tasks.view").allowed,
    performance: can(actor, "performance.view").allowed,
  };
  if (propertyIds.length === 0) return { properties, selected, today, sees, empty: true as const };

  const inScope = inArray(schema.reservations.propertyId, propertyIds);
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = addDays(`${nextMonthKey(today)}-01`, -1);

  const [counts, movements, forward, units, villas, tasks, month, conflicts] = await Promise.all([
    sees.reservations ? todayCounts(actor, today, selected?.id) : null,
    sees.reservations ? todaysMovements(propertyIds, today) : [],
    sees.reservations
      ? db
          .select({ checkIn: schema.reservations.checkIn, checkOut: schema.reservations.checkOut })
          .from(schema.reservations)
          .where(and(inScope, inArray(schema.reservations.status, ["hold", "confirmed", "in_house"]), lt(schema.reservations.checkIn, addDays(today, FORWARD_NIGHTS)), gt(schema.reservations.checkOut, today)))
      : [],
    db.select({ id: schema.units.id }).from(schema.units).where(and(inArray(schema.units.propertyId, propertyIds), eq(schema.units.isActive, true))),
    sees.villas || sees.reservations ? Promise.all((selected ? [selected] : properties).map((p) => villaStatus(actor, p.slug, now))) : [],
    sees.tasks ? taskBoard(db, { propertyIds, now }) : [],
    sees.performance ? buildReport(actor, { property: selected?.slug, from: monthStart, to: monthEnd }) : null,
    sees.reservations ? calendarConflicts(db, { propertyIds, today, now }) : [],
  ]);

  // Nights sold for each of the coming nights (holds count: the villa is taken while the guest pays).
  const nights = Array.from({ length: FORWARD_NIGHTS }, (_, i) => {
    const date = addDays(today, i);
    const sold = forward.filter((r) => r.checkIn <= date && date < r.checkOut).length;
    return { date, sold, available: units.length };
  });

  const villaRows = villas.flatMap((v) => v.units.map((u) => ({ ...u, propertyName: v.property?.name ?? "" })));
  const byUnit = new Map(villaRows.map((u) => [u.id, u]));
  const notReady = villaRows.filter((u) => u.arrival && u.readiness !== "ready");
  const villaSummary = {
    ready: villaRows.filter((u) => u.readiness === "ready").length,
    occupied: villaRows.filter((u) => u.readiness === "occupied").length,
    dirty: villaRows.filter((u) => u.readiness === "dirty").length,
    inspect: villaRows.filter((u) => u.readiness === "inspect").length,
    maintenance: villaRows.filter((u) => u.readiness === "maintenance").length,
    total: villaRows.length,
  };

  const activeTasks = tasks.filter((t) => t.task.status === "open" || t.task.status === "in_progress");
  const taskSummary = {
    open: activeTasks.length,
    late: activeTasks.filter((t) => urgency(t.task, today, nowTime) === "late").length,
    unassigned: activeTasks.filter((t) => !t.task.assigneeId).length,
    dueToday: activeTasks.filter((t) => t.task.dueDate === today).length,
  };

  const arrivals = movements
    .filter((m) => m.checkIn === today)
    .map((m) => ({ ...m, readiness: byUnit.get(m.unitId)?.readiness ?? null, earlyCheckin: byUnit.get(m.unitId)?.earlyCheckin ?? null }));
  const departures = movements.filter((m) => m.checkOut === today).map((m) => ({ ...m, lateCheckout: byUnit.get(m.unitId)?.lateCheckout ?? null }));

  const perf = month
    ? {
        from: month.from,
        to: month.to,
        current: { ...month.current.perf.totals, ...ratios(month.current.perf.totals) },
        previous: { ...month.previous.perf.totals, ...ratios(month.previous.perf.totals) },
        bookingsMade: month.current.made.rows.length,
      }
    : null;

  return {
    properties,
    selected,
    today,
    nowTime,
    sees,
    empty: false as const,
    counts,
    arrivals,
    departures,
    tonight: nights[0],
    nights,
    villaSummary,
    notReady,
    taskSummary,
    perf,
    conflicts: conflicts.length,
  };
}

function nextMonthKey(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** Today's arrivals (confirmed or already in) and departures (in house or already out). */
async function todaysMovements(propertyIds: string[], today: string) {
  const r = schema.reservations;
  return getDb()
    .select({
      id: r.id,
      code: r.code,
      status: r.status,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      adults: r.adults,
      children: r.children,
      eta: r.estimatedArrival,
      balance: sql<number>`(${r.totalAmount} - ${r.amountPaid} + coalesce(${r.refundAmount}, 0))::bigint`,
      guestName: schema.guests.fullName,
      guestTags: schema.guests.tags,
      guestPastStays: sql<number>`(SELECT count(*)::int FROM ${schema.reservations} p WHERE p.guest_id = ${r.guestId} AND p.status = 'checked_out' AND p.check_out <= ${r.checkIn})`,
      unitId: r.unitId,
      unitCode: schema.units.code,
      propertyName: schema.properties.name,
    })
    .from(r)
    .innerJoin(schema.guests, eq(schema.guests.id, r.guestId))
    .innerJoin(schema.units, eq(schema.units.id, r.unitId))
    .innerJoin(schema.properties, eq(schema.properties.id, r.propertyId))
    .where(
      and(
        inArray(r.propertyId, propertyIds),
        sql`((${r.checkIn} = ${today} AND ${r.status} IN ('confirmed', 'in_house')) OR (${r.checkOut} = ${today} AND ${r.status} IN ('in_house', 'checked_out')))`,
      ),
    )
    .orderBy(asc(r.estimatedArrival), asc(schema.units.code));
}
