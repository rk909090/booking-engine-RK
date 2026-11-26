import { and, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { addDays, diffDays } from "./dates";
import type { PriceSnapshot } from "./types";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/*
 * Reports for directors and branch managers (decided with the owner,
 * 25 Nov 2026):
 *
 * - Room performance per night stayed: room revenue is the nights' price after
 *   discount, without tax and service. Extras (late check-out, early check-in
 *   fees) are reported apart and are not in ADR. Sold = confirmed, in house or
 *   checked out. Available = active villas x nights, minus maintenance blocks.
 *   Occupancy = sold / available; ADR = revenue / sold; RevPAR = revenue / available.
 * - Bookings made: created in the period (property date) and ever confirmed.
 * - Cancellations (of confirmed bookings, by cancellation date) and no-shows
 *   (by arrival date), with what was kept after refunds.
 * Every figure is also computed for the same dates one year earlier.
 */

export const SOLD_STATUSES = ["confirmed", "in_house", "checked_out"] as const;

export type ReportUnit = { id: string; code: string; name: string; unitTypeId: string; typeName: string; propertyId: string; propertyName: string; isActive: boolean };
export type ReportBlock = { unitId: string; startDate: string; endDate: string };
export type ReportReservation = {
  code: string;
  propertyId: string;
  unitId: string;
  status: string;
  source: string;
  checkIn: string;
  checkOut: string;
  subtotalAmount: number;
  discountAmount: number;
  extrasAmount: number;
  /** Breakfast plan: reported with the extras, not as room revenue. */
  breakfastAmount?: number;
  amountPaid: number;
  refundAmount: number | null;
  priceSnapshot: PriceSnapshot | null;
  /** Date the booking was made, at the property. */
  createdDate: string;
  /** Date it was cancelled, at the property. */
  cancelledDate: string | null;
  /** It was a hold (never confirmed) when cancelled. */
  cancelledFromHold: boolean;
};

/** The same calendar dates one year earlier (29 Feb becomes 28 Feb). */
export function yearEarlier(date: string): string {
  const y = Number(date.slice(0, 4)) - 1;
  const md = date.slice(5) === "02-29" ? "02-28" : date.slice(5);
  return `${y}-${md}`;
}

/** Net room revenue per night: the discount is spread over the nights in proportion to their rate. */
export function netNights(r: Pick<ReportReservation, "priceSnapshot" | "checkIn" | "checkOut" | "subtotalAmount" | "discountAmount">): Array<{ date: string; net: number }> {
  const stayed = (date: string) => date >= r.checkIn && date < r.checkOut;
  const snap = r.priceSnapshot;
  if (snap?.nights.length) {
    const discount = snap.discount ?? 0;
    const subtotal = snap.subtotal || snap.nights.reduce((s, n) => s + n.rate, 0);
    const shares = snap.nights.map((n) => (subtotal > 0 ? Math.floor((discount * n.rate) / subtotal) : 0));
    let rest = discount - shares.reduce((s, x) => s + x, 0);
    const nights = snap.nights.map((n, i) => {
      const extra = rest > 0 ? 1 : 0;
      rest -= extra;
      return { date: n.date, net: n.rate - shares[i] - extra };
    });
    return nights.filter((n) => stayed(n.date));
  }
  const count = Math.max(1, diffDays(r.checkIn, r.checkOut));
  const net = r.subtotalAmount - r.discountAmount;
  return Array.from({ length: count }, (_, i) => ({ date: addDays(r.checkIn, i), net: Math.floor(net / count) + (i < net % count ? 1 : 0) }));
}

export type Perf = { available: number; sold: number; revenue: number; extras: number };
export const emptyPerf = (): Perf => ({ available: 0, sold: 0, revenue: 0, extras: 0 });

export function ratios(p: Perf) {
  return {
    occupancy: p.available > 0 ? p.sold / p.available : 0,
    adr: p.sold > 0 ? Math.round(p.revenue / p.sold) : 0,
    revpar: p.available > 0 ? Math.round(p.revenue / p.available) : 0,
  };
}

/** Room performance for [from, to] (both nights included), per villa and per day or month. */
export function performance(input: {
  from: string;
  to: string;
  units: ReportUnit[];
  blocks: ReportBlock[];
  reservations: ReportReservation[];
  /** Which bookings count as sold (default: confirmed, in house, checked out). */
  counts?: (r: ReportReservation) => boolean;
  /** Group by day or month (default: by day up to 62 nights). */
  bucket?: "day" | "month";
}) {
  const { from, to } = input;
  const inRange = (d: string) => d >= from && d <= to;
  const nights = diffDays(from, to) + 1;
  const byDay = input.bucket ? input.bucket === "day" : nights <= 62;
  const bucketOf = byDay ? (d: string) => d : (d: string) => d.slice(0, 7);
  const counts = input.counts ?? ((r: ReportReservation) => (SOLD_STATUSES as readonly string[]).includes(r.status));
  const byUnit = new Map<string, Perf>();
  const series = new Map<string, Perf>();
  const unit = (id: string) => byUnit.get(id) ?? byUnit.set(id, emptyPerf()).get(id)!;
  const bucket = (d: string) => series.get(bucketOf(d)) ?? series.set(bucketOf(d), emptyPerf()).get(bucketOf(d))!;
  for (let i = 0; i < nights; i++) bucket(addDays(from, i));

  for (const u of input.units) {
    if (!u.isActive) continue;
    const blocked = new Set<string>();
    for (const b of input.blocks.filter((x) => x.unitId === u.id)) {
      for (let d = b.startDate; d < b.endDate; d = addDays(d, 1)) if (inRange(d)) blocked.add(d);
    }
    for (let i = 0; i < nights; i++) {
      const d = addDays(from, i);
      if (blocked.has(d)) continue;
      unit(u.id).available++;
      bucket(d).available++;
    }
  }

  for (const r of input.reservations) {
    if (!counts(r)) continue;
    for (const n of netNights(r)) {
      if (!inRange(n.date)) continue;
      unit(r.unitId).sold++;
      unit(r.unitId).revenue += n.net;
      bucket(n.date).sold++;
      bucket(n.date).revenue += n.net;
    }
    // Extras belong to the last night (a late check-out fee is charged on departure).
    const lastNight = addDays(r.checkOut, -1);
    const extras = r.extrasAmount + (r.breakfastAmount ?? 0);
    if (extras > 0 && inRange(lastNight)) {
      unit(r.unitId).extras += extras;
      bucket(lastNight).extras += extras;
    }
  }

  const totals = emptyPerf();
  for (const p of byUnit.values()) {
    totals.available += p.available;
    totals.sold += p.sold;
    totals.revenue += p.revenue;
    totals.extras += p.extras;
  }
  return { totals, byUnit, series: [...series.entries()].map(([key, p]) => ({ key, ...p })), bucket: byDay ? ("day" as const) : ("month" as const) };
}

/** Adds up per-villa figures by property or villa type. */
export function rollup(byUnit: Map<string, Perf>, units: ReportUnit[], key: "propertyId" | "unitTypeId") {
  const out = new Map<string, Perf>();
  for (const [unitId, p] of byUnit) {
    const u = units.find((x) => x.id === unitId);
    if (!u) continue;
    const acc = out.get(u[key]) ?? out.set(u[key], emptyPerf()).get(u[key])!;
    acc.available += p.available;
    acc.sold += p.sold;
    acc.revenue += p.revenue;
    acc.extras += p.extras;
  }
  return out;
}

/*
 * Pace: what is on the books for future stay dates as of a given day, compared
 * with the same point last year (STLY: as of the same date a year earlier, for
 * stay dates a year earlier), and the net pickup over the last days. A booking
 * was on the books on a day if it had been made by then, was ever confirmed
 * (unpaid holds never count), and had not been cancelled yet. Bookings whose
 * dates were changed later are counted on their current dates and price.
 */

/** Whether a booking was on the books at the end of `asOf` (a property date). */
export function onBooksAsOf(r: ReportReservation, asOf: string): boolean {
  if (r.createdDate > asOf) return false;
  if (r.status === "hold" || r.status === "expired") return false;
  if (r.status === "cancelled") return !r.cancelledFromHold && r.cancelledDate !== null && r.cancelledDate > asOf;
  return true;
}

/** On-the-books nights and revenue per stay month for [from, to], as of a day. */
export function onTheBooks(input: { asOf: string; from: string; to: string; units: ReportUnit[]; blocks: ReportBlock[]; reservations: ReportReservation[] }) {
  return performance({ ...input, bucket: "month", counts: (r) => onBooksAsOf(r, input.asOf) });
}

const roomValue = (r: ReportReservation) => r.subtotalAmount - r.discountAmount;
const nightsOf = (r: ReportReservation) => diffDays(r.checkIn, r.checkOut);
const kept = (r: ReportReservation) => Math.max(0, r.amountPaid - (r.refundAmount ?? 0));

/** Bookings made in the period (created then, ever confirmed), with their source, lead time and length. */
export function bookingsMade(input: { from: string; to: string; reservations: ReportReservation[] }) {
  const rows = input.reservations.filter(
    (r) => r.createdDate >= input.from && r.createdDate <= input.to && r.status !== "hold" && r.status !== "expired" && !(r.status === "cancelled" && r.cancelledFromHold),
  );
  const bySource = new Map<string, { count: number; nights: number; value: number }>();
  for (const r of rows) {
    const s = bySource.get(r.source) ?? bySource.set(r.source, { count: 0, nights: 0, value: 0 }).get(r.source)!;
    s.count++;
    s.nights += nightsOf(r);
    s.value += roomValue(r);
  }
  const sum = (f: (r: ReportReservation) => number) => rows.reduce((s, r) => s + f(r), 0);
  const discounted = rows.filter((r) => r.discountAmount > 0);
  return {
    rows,
    count: rows.length,
    nights: sum(nightsOf),
    value: sum(roomValue),
    avgLeadDays: rows.length ? sum((r) => Math.max(0, diffDays(r.createdDate, r.checkIn))) / rows.length : 0,
    avgNights: rows.length ? sum(nightsOf) / rows.length : 0,
    discountedCount: discounted.length,
    discountTotal: discounted.reduce((s, r) => s + r.discountAmount, 0),
    bySource,
  };
}

/** Cancelled confirmed bookings (by cancellation date) and no-shows (by arrival date). */
export function lostBookings(input: { from: string; to: string; reservations: ReportReservation[]; bookingsMadeCount: number }) {
  const inRange = (d: string | null) => d !== null && d >= input.from && d <= input.to;
  const cancelled = input.reservations.filter((r) => r.status === "cancelled" && !r.cancelledFromHold && inRange(r.cancelledDate));
  const noShows = input.reservations.filter((r) => r.status === "no_show" && inRange(r.checkIn));
  const arrivals = input.reservations.filter(
    (r) => inRange(r.checkIn) && ((SOLD_STATUSES as readonly string[]).includes(r.status) || r.status === "no_show"),
  ).length;
  const summary = (rows: ReportReservation[]) => ({
    count: rows.length,
    value: rows.reduce((s, r) => s + roomValue(r), 0),
    kept: rows.reduce((s, r) => s + kept(r), 0),
  });
  return {
    cancelled: { ...summary(cancelled), rows: cancelled, rate: input.bookingsMadeCount > 0 ? cancelled.length / input.bookingsMadeCount : 0 },
    noShows: { ...summary(noShows), rows: noShows, rate: arrivals > 0 ? noShows.length / arrivals : 0 },
    keptOf: kept,
    valueOf: roomValue,
  };
}

/**
 * Everything the report needs for some properties and [from, to]: their villas,
 * maintenance blocks, and the bookings that stay, were made, or were cancelled
 * in the period.
 */
export async function loadReportData(db: AnyDb, input: { propertyIds: string[]; from: string; to: string }) {
  if (input.propertyIds.length === 0) return { units: [] as ReportUnit[], blocks: [] as ReportBlock[], reservations: [] as ReportReservation[] };
  const { from, to } = input;
  const end = addDays(to, 1);
  const tz = schema.properties.timezone;
  const createdDate = sql<string>`to_char(${schema.reservations.createdAt} AT TIME ZONE ${tz}, 'YYYY-MM-DD')`;
  const cancelledDate = sql<string | null>`to_char(${schema.reservations.cancelledAt} AT TIME ZONE ${tz}, 'YYYY-MM-DD')`;
  const [units, blocks, reservations] = await Promise.all([
    db
      .select({
        id: schema.units.id,
        code: schema.units.code,
        name: schema.units.name,
        unitTypeId: schema.units.unitTypeId,
        typeName: schema.unitTypes.name,
        propertyId: schema.units.propertyId,
        propertyName: schema.properties.name,
        isActive: schema.units.isActive,
      })
      .from(schema.units)
      .innerJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.units.unitTypeId))
      .innerJoin(schema.properties, eq(schema.properties.id, schema.units.propertyId))
      .where(inArray(schema.units.propertyId, input.propertyIds))
      .orderBy(schema.properties.name, schema.unitTypes.sortOrder, schema.units.code),
    db
      .select({ unitId: schema.unitBlocks.unitId, startDate: schema.unitBlocks.startDate, endDate: schema.unitBlocks.endDate })
      .from(schema.unitBlocks)
      .innerJoin(schema.units, eq(schema.units.id, schema.unitBlocks.unitId))
      .where(and(inArray(schema.units.propertyId, input.propertyIds), lt(schema.unitBlocks.startDate, end), gte(schema.unitBlocks.endDate, from))),
    db
      .select({
        code: schema.reservations.code,
        propertyId: schema.reservations.propertyId,
        unitId: schema.reservations.unitId,
        status: schema.reservations.status,
        source: schema.reservations.source,
        checkIn: schema.reservations.checkIn,
        checkOut: schema.reservations.checkOut,
        subtotalAmount: schema.reservations.subtotalAmount,
        discountAmount: schema.reservations.discountAmount,
        extrasAmount: schema.reservations.extrasAmount,
        breakfastAmount: schema.reservations.breakfastAmount,
        amountPaid: schema.reservations.amountPaid,
        refundAmount: schema.reservations.refundAmount,
        priceSnapshot: schema.reservations.priceSnapshot,
        createdDate,
        cancelledDate,
        cancelledFromHold: sql<boolean>`EXISTS (SELECT 1 FROM ${schema.auditEvents} a WHERE a.entity_type = 'reservation' AND a.entity_id = ${schema.reservations.id}::text
          AND a.action = 'reservation.cancelled' AND a.before ->> 'status' = 'hold')`,
      })
      .from(schema.reservations)
      .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
      .where(
        and(
          inArray(schema.reservations.propertyId, input.propertyIds),
          or(
            and(lt(schema.reservations.checkIn, end), sql`${schema.reservations.checkOut} > ${from}`),
            and(sql`${createdDate} >= ${from}`, sql`${createdDate} <= ${to}`),
            and(sql`${cancelledDate} >= ${from}`, sql`${cancelledDate} <= ${to}`),
            and(gte(schema.reservations.checkIn, from), lte(schema.reservations.checkIn, to)),
          ),
        ),
      ),
  ]);
  return { units, blocks, reservations: reservations.map((r) => ({ ...r, cancelledFromHold: Boolean(r.cancelledFromHold) })) };
}
