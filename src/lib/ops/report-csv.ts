import { diffDays } from "@/domain/dates";
import { ratios, rollup, type Perf, type ReportReservation, type ReportUnit } from "@/domain/reports";

/*
 * CSV versions of the report tables. Plain numbers (no currency symbols or
 * thousands separators) so spreadsheets can add them up; booking codes, never
 * guest names.
 */

export const CSV_SECTIONS = ["villas", "series", "bookings", "lost"] as const;
export type CsvSection = (typeof CSV_SECTIONS)[number];

type Report = {
  units: ReportUnit[];
  current: {
    perf: { byUnit: Map<string, Perf>; series: Array<{ key: string } & Perf>; totals: Perf };
    made: { rows: ReportReservation[] };
    lost: { cancelled: { rows: ReportReservation[] }; noShows: { rows: ReportReservation[] }; keptOf: (r: ReportReservation) => number; valueOf: (r: ReportReservation) => number };
  };
};

function cell(value: string | number): string {
  const text = String(value);
  // Quote when needed; a leading =, +, - or @ is neutralised so a spreadsheet never runs it as a formula.
  const safe = /^[=+\-@]/.test(text) && typeof value === "string" ? `'${text}` : text;
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const csv = (rows: Array<Array<string | number>>) => "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
const pct = (x: number) => (x * 100).toFixed(1);

function perfRow(p: Perf) {
  const r = ratios(p);
  return [p.available, p.sold, pct(r.occupancy), p.revenue, r.adr, r.revpar, p.extras];
}

const PERF_HEAD = ["available_nights", "sold_nights", "occupancy_pct", "room_revenue", "adr", "revpar", "extras"];

export function reportCsv(report: Report, section: CsvSection): string {
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
    return csv(rows);
  }
  if (section === "series") {
    return csv([["period", ...PERF_HEAD], ...current.perf.series.map((s) => [s.key, ...perfRow(s)])]);
  }
  if (section === "bookings") {
    return csv([
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
    ]);
  }
  return csv([
    ["code", "property", "villa", "kind", "date", "check_in", "room_value", "kept_after_refund"],
    ...current.lost.cancelled.rows.map((r) => [r.code, unit(r.unitId)?.propertyName ?? "", unit(r.unitId)?.code ?? "", "cancelled", r.cancelledDate ?? "", r.checkIn, current.lost.valueOf(r), current.lost.keptOf(r)]),
    ...current.lost.noShows.rows.map((r) => [r.code, unit(r.unitId)?.propertyName ?? "", unit(r.unitId)?.code ?? "", "no_show", r.checkIn, r.checkIn, current.lost.valueOf(r), current.lost.keptOf(r)]),
  ]);
}
