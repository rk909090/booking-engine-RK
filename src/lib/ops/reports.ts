import "server-only";
import { getDb } from "@/db/client";
import { addDays, diffDays, isIsoDate, todayIn } from "@/domain/dates";
import { bookingsMade, loadReportData, lostBookings, performance, yearEarlier } from "@/domain/reports";
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
