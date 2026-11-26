import { diffDays } from "@/domain/dates";
import { ratios, rollup, type Perf, type ReportReservation, type ReportUnit } from "@/domain/reports";

/*
 * CSV versions of the report tables. Plain numbers (no currency symbols or
 * thousands separators) so spreadsheets can add them up; booking codes, never
 * guest names.
 */

export const CSV_SECTIONS = ["villas", "series", "bookings", "lost"] as const;
export type CsvSection = (typeof CSV_SECTIONS)[number];

export type Report = {
  units: ReportUnit[];
  current: {
    perf: { byUnit: Map<string, Perf>; series: Array<{ key: string } & Perf>; totals: Perf };
    made: { rows: ReportReservation[] };
    lost: { cancelled: { rows: ReportReservation[] }; noShows: { rows: ReportReservation[] }; keptOf: (r: ReportReservation) => number; valueOf: (r: ReportReservation) => number };
  };
};

export function cell(value: string | number): string {
  const text = String(value);
  // Quote when needed; a leading =, +, - or @ is neutralised so a spreadsheet never runs it as a formula.
  const safe = /^[=+\-@]/.test(text) && typeof value === "string" ? `'${text}` : text;
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const csv = (rows: Array<Array<string | number>>) => "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
/** Percentage with one decimal, as a number (so spreadsheets can sum and chart it). */
const pct = (x: number) => Math.round(x * 1000) / 10;

function perfRow(p: Perf) {
  const r = ratios(p);
  return [p.available, p.sold, pct(r.occupancy), p.revenue, r.adr, r.revpar, p.extras];
}

const PERF_HEAD = ["available_nights", "sold_nights", "occupancy_pct", "room_revenue", "adr", "revpar", "extras"];

export type Rows = Array<Array<string | number>>;

/** The rows of one report table (header first). */
export function reportRows(report: Report, section: CsvSection): Rows {
  const { units, current } = report;
  const unit = (id: string) => units.find((u) => u.id === id);
  if (section === "villas") {
    const rows: Array<Array<string | number>> = [["property", "villa_type", "villa", ...PERF_HEAD]];
    for (const u of units) {
      const p = current.perf.byUnit.get(u.id);
      if (p) rows.push([u.propertyName, u.typeName, u.code, ...perfRow(p)]);
    }
    for (const [typeId, p] of rollup(current.perf.byUnit, units, "unitTypeId")) {
      const u = units.find((x) => x.unitTypeId === typeId)!;
      rows.push([u.propertyName, u.typeName, "(all)", ...perfRow(p)]);
    }
    rows.push(["(all)", "(all)", "(all)", ...perfRow(current.perf.totals)]);
    return rows;
  }
  if (section === "series") {
    return [["period", ...PERF_HEAD], ...current.perf.series.map((s) => [s.key, ...perfRow(s)])];
  }
  if (section === "bookings") {
    return [
      ["code", "property", "villa", "booked_on", "source", "check_in", "check_out", "nights", "lead_days", "room_value", "discount", "status"],
      ...current.made.rows.map((r) => [
        r.code,
        unit(r.unitId)?.propertyName ?? "",
        unit(r.unitId)?.code ?? "",
        r.createdDate,
        r.source,
        r.checkIn,
        r.checkOut,
        diffDays(r.checkIn, r.checkOut),
        Math.max(0, diffDays(r.createdDate, r.checkIn)),
        r.subtotalAmount - r.discountAmount,
        r.discountAmount,
        r.status,
      ]),
    ];
  }
  return [
    ["code", "property", "villa", "kind", "date", "check_in", "room_value", "kept_after_refund"],
    ...current.lost.cancelled.rows.map((r) => [r.code, unit(r.unitId)?.propertyName ?? "", unit(r.unitId)?.code ?? "", "cancelled", r.cancelledDate ?? "", r.checkIn, current.lost.valueOf(r), current.lost.keptOf(r)]),
    ...current.lost.noShows.rows.map((r) => [r.code, unit(r.unitId)?.propertyName ?? "", unit(r.unitId)?.code ?? "", "no_show", r.checkIn, r.checkIn, current.lost.valueOf(r), current.lost.keptOf(r)]),
  ];
}

export function reportCsv(report: Report, section: CsvSection): string {
  return csv(reportRows(report, section));
}

type PaceSeries = Array<{ key: string } & Perf>;

/** The pace table: per stay month, on the books now, a week ago, at the same point last year, and last year's final result. */
export type PaceInput = { current: { series: PaceSeries }; weekAgo: { series: PaceSeries }; stly: { series: PaceSeries }; lyFinal: { series: PaceSeries } };

export function paceCsv(pace: PaceInput): string {
  return csv(paceRows(pace));
}

export function paceRows(pace: PaceInput): Rows {
  const lyKey = (key: string) => `${Number(key.slice(0, 4)) - 1}${key.slice(4)}`;
  const find = (series: PaceSeries, key: string) => series.find((s) => s.key === key);
  const rows: Array<Array<string | number>> = [
    [
      "stay_month",
      "available_nights",
      "otb_nights",
      "otb_occupancy_pct",
      "otb_room_revenue",
      "otb_adr",
      "pickup_nights_7d",
      "pickup_revenue_7d",
      "stly_nights",
      "stly_room_revenue",
      "ly_final_nights",
      "ly_final_room_revenue",
    ],
  ];
  for (const s of pace.current.series) {
    const week = find(pace.weekAgo.series, s.key);
    const stly = find(pace.stly.series, lyKey(s.key));
    const final = find(pace.lyFinal.series, lyKey(s.key));
    const r = ratios(s);
    rows.push([
      s.key,
      s.available,
      s.sold,
      pct(r.occupancy),
      s.revenue,
      r.adr,
      s.sold - (week?.sold ?? 0),
      s.revenue - (week?.revenue ?? 0),
      stly?.sold ?? 0,
      stly?.revenue ?? 0,
      final?.sold ?? 0,
      final?.revenue ?? 0,
    ]);
  }
  return rows;
}
