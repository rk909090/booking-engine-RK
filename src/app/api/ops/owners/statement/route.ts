import { getDb } from "@/db/client";
import { buildStatements, monthStart } from "@/domain/owners";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { visibleProperties } from "@/lib/ops/queries";
import { ownerStatementXlsx } from "@/lib/ops/report-xlsx";
import { xlsxHeaders } from "@/lib/xlsx";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An owner statement as Excel: /api/ops/owners/statement?owner=&property=&month=YYYY-MM. Directors and branch managers. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const staff = await requireStaff("id");
  const ownerId = url.searchParams.get("owner") ?? "";
  const month = url.searchParams.get("month") ?? "";
  const property = (await visibleProperties(staff.actor)).find((p) => p.slug === url.searchParams.get("property"));
  if (!UUID.test(ownerId) || !property || !monthStart(month)) return new Response("Not found", { status: 404 });
  if (!can(staff.actor, "owners.view", property.id).allowed) return new Response("Forbidden", { status: 403 });
  const row = (await buildStatements(getDb(), { propertyId: property.id, month }))?.find((r) => r.ownerId === ownerId);
  if (!row) return new Response("Not found", { status: 404 });
  const name = row.data.owner.fullName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  return new Response(Buffer.from(ownerStatementXlsx(row.data, row.status)), { headers: xlsxHeaders(`owner-statement-${property.slug}-${month}-${name}.xlsx`) });
}
