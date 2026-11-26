import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { listReservations } from "@/lib/ops/queries";
import { reservationsXlsx } from "@/lib/ops/report-xlsx";
import { xlsxHeaders } from "@/lib/xlsx";

const MAX_ROWS = 5000;

/** The reservation list with the page's filters, as Excel (up to 5,000 rows). Staff who may see reservations. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const staff = await requireStaff("id");
  if (!can(staff.actor, "reservation.view").allowed) return new Response("Forbidden", { status: 403 });
  const p = (k: string) => url.searchParams.get(k) ?? undefined;
  const list = await listReservations(staff.actor, {
    q: p("q"),
    status: p("status"),
    property: p("property"),
    from: p("from"),
    to: p("to"),
    departOn: p("departOn"),
    refund: p("refund"),
    requests: p("requests"),
    deposit: p("deposit"),
    today: p("today"),
    page: 1,
    pageSize: MAX_ROWS,
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(Buffer.from(reservationsXlsx(list.rows)), { headers: xlsxHeaders(`reservations-${list.applied.property || "all"}-${stamp}.xlsx`) });
}
