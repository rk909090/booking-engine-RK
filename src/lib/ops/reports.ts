import "server-only";
import { getDb } from "@/db/client";
import { addDays, diffDays, isIsoDate, todayIn } from "@/domain/dates";
import { bookingsMade, loadReportData, lostBookings, onTheBooks, performance, yearEarlier } from "@/domain/reports";
import { can, type Actor } from "@/lib/authz/permissions";
import { visibleProperties } from "./queries";

/** Longest period one report covers. */
export const MAX_REPORT_DAYS = 366;

export type ReportFilters = { property?: string; from?: string; to?: string };

/** The properties this actor may see reports for, and the period asked for (this month by default). */
export async function reportScope(actor: Actor, filters: ReportFilters) {
  const properties = (await visibleProperties(actor)).filter((p) => can(actor, "performance.view", p.id).allowed);
  const property = properties.find((p) => p.slug === filters.property) ?? null;
  const today = todayIn(properties[0]?.timezone ?? "Asia/Makassar");
  const monthStart = `${today.slice(0, 8)}01`;
  const monthEnd = addDays(`${addDays(monthStart, 32).slice(0, 8)}01`, -1);
  let from = isIsoDate(filters.from) ? filters.from : monthStart;
  let to = isIsoDate(filters.to) ? filters.to : monthEnd;
  if (to < from) [from, to] = [to, from];
  if (diffDays(from, to) + 1 > MAX_REPORT_DAYS) to = addDays(from, MAX_REPORT_DAYS - 1);
  return { properties, property, propertyIds: property ? [property.id] : properties.map((p) => p.id), from, to, today };
}

/** All report figures for the period and the same dates a year earlier. */
export async function buildReport(actor: Actor, filters: ReportFilters) {
  const scope = await reportScope(actor, filters);
  const prevFrom = yearEarlier(scope.from);
  const prevTo = yearEarlier(scope.to);
  const [now, prev] = await Promise.all([
    loadReportData(getDb(), { propertyIds: scope.propertyIds, from: scope.from, to: scope.to }),
    loadReportData(getDb(), { propertyIds: scope.propertyIds, from: prevFrom, to: prevTo }),
  ]);
  const compute = (data: typeof now, from: string, to: string) => {
    const perf = performance({ from, to, ...data });
    const made = bookingsMade({ from, to, reservations: data.reservations });
    const lost = lostBookings({ from, to, reservations: data.reservations, bookingsMadeCount: made.count });
    return { perf, made, lost };
  };
  return {
    ...scope,
    units: now.units,
    current: compute(now, scope.from, scope.to),
    previous: { from: prevFrom, to: prevTo, ...compute(prev, prevFrom, prevTo) },
  };
}

/** How far ahead the pace report looks, in months (the current month counts as the first). */
export const PACE_HORIZONS = [3, 6, 12] as const;
/** Pickup is the change in what is on the books over this many days. */
export const PICKUP_DAYS = 7;

/**
 * On the books from today to the end of the horizon, by stay month, with the
 * same point last year, last year's final result for those months, and the
 * pickup of the last PICKUP_DAYS days.
 */
export async function buildPace(actor: Actor, filters: { property?: string; months?: string }) {
  const scope = await reportScope(actor, { property: filters.property });
  const months = (PACE_HORIZONS as readonly number[]).includes(Number(filters.months)) ? Number(filters.months) : 6;
  const from = scope.today;
  let monthStart = `${from.slice(0, 8)}01`;
  for (let i = 1; i < months; i++) monthStart = `${addDays(monthStart, 32).slice(0, 8)}01`;
  const to = addDays(`${addDays(monthStart, 32).slice(0, 8)}01`, -1);
  const lyFrom = yearEarlier(from);
  const lyTo = yearEarlier(to);
  const [now, ly] = await Promise.all([
    loadReportData(getDb(), { propertyIds: scope.propertyIds, from, to }),
    loadReportData(getDb(), { propertyIds: scope.propertyIds, from: lyFrom, to: lyTo }),
  ]);
  const pickupFrom = addDays(from, -PICKUP_DAYS);
  return {
    ...scope,
    months,
    from,
    to,
    lyFrom,
    lyTo,
    pickupFrom,
    current: onTheBooks({ asOf: from, from, to, ...now }),
    weekAgo: onTheBooks({ asOf: pickupFrom, from, to, ...now }),
    stly: onTheBooks({ asOf: lyFrom, from: lyFrom, to: lyTo, ...ly }),
    lyFinal: performance({ from: lyFrom, to: lyTo, bucket: "month", ...ly }),
  };
}
