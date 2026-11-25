import { hasLocale } from "@/i18n/config";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { CSV_SECTIONS, paceCsv, reportCsv, type CsvSection } from "@/lib/ops/report-csv";
import { buildPace, buildReport } from "@/lib/ops/reports";

/**
 * Report tables as CSV: /api/ops/reports?section=villas|series|bookings|lost|pace
 * with the same property/from/to as the report page. Directors and branch
 * managers only, limited to their properties.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const langRaw = url.searchParams.get("lang") ?? "id";
  const staff = await requireStaff(hasLocale(langRaw) ? langRaw : "id");
  if (!can(staff.actor, "performance.view").allowed) return new Response("Forbidden", { status: 403 });
  const section = url.searchParams.get("section") ?? "";
  const headers = (name: string) => ({
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${name}"`,
    "cache-control": "private, no-store",
  });
  if (section === "pace") {
    const pace = await buildPace(staff.actor, { property: url.searchParams.get("property") ?? undefined, months: url.searchParams.get("months") ?? undefined });
    return new Response(paceCsv(pace), { headers: headers(`report-pace-${pace.property?.slug ?? "all"}-${pace.from}-${pace.to}.csv`) });
  }
  if (!(CSV_SECTIONS as readonly string[]).includes(section)) return new Response("Unknown section", { status: 400 });

  const report = await buildReport(staff.actor, {
    property: url.searchParams.get("property") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });
  const name = `report-${section}-${report.property?.slug ?? "all"}-${report.from}-${report.to}.csv`;
  return new Response(reportCsv(report, section as CsvSection), { headers: headers(name) });
}
