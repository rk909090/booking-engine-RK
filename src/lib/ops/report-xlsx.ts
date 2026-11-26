import { ratios, type Perf } from "@/domain/reports";
import type { OwnerStatementData } from "@/domain/types";
import { buildXlsx, type Cell, type Sheet } from "@/lib/xlsx";
import { paceRows, reportRows, type PaceInput, type Report } from "./report-csv";

/*
 * Excel versions of the reports (decided with the owner, 26 Nov 2026): one
 * workbook per report, one sheet per table, plain numbers so they add up,
 * booking codes rather than guest names.
 */

const pct = (x: number) => Math.round(x * 1000) / 10;

function summaryRows(title: string, lines: Array<[string, Cell]>): Cell[][] {
  return [[title, ""], ...lines.map(([k, v]) => [k, v])];
}

function perfLines(p: Perf, label = ""): Array<[string, Cell]> {
  const r = ratios(p);
  return [
    [`${label}available_nights`, p.available],
    [`${label}sold_nights`, p.sold],
    [`${label}occupancy_pct`, pct(r.occupancy)],
    [`${label}room_revenue`, p.revenue],
    [`${label}adr`, r.adr],
    [`${label}revpar`, r.revpar],
    [`${label}extras`, p.extras],
  ];
}

/** The period report: summary (with the same dates last year), villas, trend, bookings made, cancellations and no-shows. */
export function reportXlsx(report: Report & { property: { name: string } | null; from: string; to: string; previous?: { from: string; to: string; perf: { totals: Perf } } }): Uint8Array {
  const lines: Array<[string, Cell]> = [
    ["property", report.property?.name ?? "(all)"],
    ["from", report.from],
    ["to", report.to],
    ...perfLines(report.current.perf.totals),
    ["bookings_made", report.current.made.rows.length],
    ["cancellations", report.current.lost.cancelled.rows.length],
    ["no_shows", report.current.lost.noShows.rows.length],
  ];
  if (report.previous) lines.push(["last_year_from", report.previous.from], ["last_year_to", report.previous.to], ...perfLines(report.previous.perf.totals, "last_year_"));
  return buildXlsx([
    { name: "Summary", rows: summaryRows("report", lines) },
    { name: "Villas", rows: reportRows(report, "villas") },
    { name: "Trend", rows: reportRows(report, "series") },
    { name: "Bookings", rows: reportRows(report, "bookings") },
    { name: "Cancellations", rows: reportRows(report, "lost") },
  ]);
}

/** The pace report: on the books by stay month with pickup, same time last year and last year's final. */
export function paceXlsx(pace: PaceInput & { property: { name: string } | null; from: string; to: string }): Uint8Array {
  return buildXlsx([
    { name: "Summary", rows: summaryRows("pace", [["property", pace.property?.name ?? "(all)"], ["from", pace.from], ["to", pace.to]]) },
    { name: "Pace", rows: paceRows(pace) },
  ]);
}

/** An owner statement: summary, villas, the bookings counted and the expenses. */
export function ownerStatementXlsx(d: OwnerStatementData, status: string): Uint8Array {
  const t = d.totals;
  const sheets: Sheet[] = [
    {
      name: "Summary",
      rows: summaryRows("owner_statement", [
        ["owner", d.owner.fullName],
        ["property", d.property.name],
        ["month", d.month.slice(0, 7)],
        ["status", status],
        ["owned_nights", t.ownedNights],
        ["sold_nights", t.soldNights],
        ["room_revenue", t.roomRevenue],
        ["channel_commission", t.commission],
        ["management_fee", t.fee],
        ["expenses", t.expenses],
        ["owner_share", t.payout],
      ]),
    },
    {
      name: "Villas",
      rows: [
        ["villa", "type", "fee_pct", "owned_nights", "sold_nights", "room_revenue", "channel_commission", "management_fee", "expenses", "owner_share"],
        ...d.units.map((u) => [u.code, u.typeName, u.feeBp / 100, u.ownedNights, u.soldNights, u.roomRevenue, u.commission, u.fee, u.expenseTotal, u.payout]),
      ],
    },
    {
      name: "Bookings",
      rows: [["villa", "booking", "check_in", "check_out", "source", "nights_in_month", "room_revenue", "channel_commission"], ...d.units.flatMap((u) => u.stays.map((s) => [u.code, s.code, s.checkIn, s.checkOut, s.source, s.nights, s.revenue, s.commission]))],
    },
    {
      name: "Expenses",
      rows: [["villa", "date", "category", "description", "source", "amount"], ...d.units.flatMap((u) => u.expenses.map((e) => [u.code, e.date, e.category, e.description, e.source, e.amount]))],
    },
  ];
  return buildXlsx(sheets);
}

export type ReservationExportRow = {
  code: string;
  status: string;
  source: string;
  propertyName: string;
  typeName: string;
  unitCode: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  guestName: string;
  totalAmount: number;
  amountPaid: number;
  refundAmount: number | null;
};

/** The reservation list as filtered on the page (staff export, so guest names are included). */
export function reservationsXlsx(rows: ReservationExportRow[]): Uint8Array {
  return buildXlsx([
    {
      name: "Reservations",
      rows: [
        ["code", "status", "source", "property", "villa_type", "villa", "check_in", "check_out", "adults", "children", "guest", "total", "paid", "balance", "refund_owed"],
        ...rows.map((r) => [
          r.code,
          r.status,
          r.source,
          r.propertyName,
          r.typeName,
          r.unitCode,
          r.checkIn,
          r.checkOut,
          r.adults,
          r.children,
          r.guestName,
          r.totalAmount,
          r.amountPaid,
          r.totalAmount - r.amountPaid + (r.refundAmount ?? 0),
          r.refundAmount ?? 0,
        ]),
      ],
    },
  ]);
}
