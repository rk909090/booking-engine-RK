import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { isIsoDate, todayIn } from "@/domain/dates";
import { foreignArrivals } from "@/domain/guests";
import { eraseExpiredDocuments } from "@/domain/pre-checkin";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { openGuestData } from "@/lib/crypto/guest-data";
import { csv } from "@/lib/ops/report-csv";

/**
 * Foreign guests arriving in [from, to] as CSV, with full document numbers,
 * to enter into APOA (immigration). Front office and branch managers of the
 * property; every export is logged on each booking it contains.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const staff = await requireStaff("id");
  const slug = url.searchParams.get("property") ?? "";
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const [property] = await getDb().select().from(schema.properties).where(eq(schema.properties.slug, slug));
  if (!property || !can(staff.actor, "guest.apoa", property.id).allowed) return new Response("Forbidden", { status: 403 });
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) return new Response("Bad dates", { status: 400 });
  await eraseExpiredDocuments(getDb(), todayIn(property.timezone));
  const rows = await foreignArrivals(getDb(), { propertyId: property.id, from, to });
  const lines: Array<Array<string | number>> = [["booking", "villa", "check_in", "check_out", "full_name", "nationality", "birth_date", "document_type", "document_number", "reported"]];
  for (const r of rows) {
    if (r.missing) lines.push([r.code, r.unitCode, r.checkIn, r.checkOut, "", "", "", "", "", r.reportedAt ? "yes" : "no"]);
    for (const g of r.guests) {
      lines.push([r.code, r.unitCode, r.checkIn, r.checkOut, g.fullName, g.nationality, g.birthDate, g.documentType ?? "", g.documentNumberEnc ? (openGuestData(g.documentNumberEnc) ?? "") : "", r.reportedAt ? "yes" : "no"]);
    }
  }
  const withNumbers = rows.filter((r) => r.guests.some((g) => g.documentNumberEnc));
  if (withNumbers.length) {
    await getDb().insert(schema.auditEvents).values(
      withNumbers.map((r) => ({ actorType: "staff", actorId: staff.staffId, propertyId: property.id, entityType: "reservation", entityId: r.reservationId, action: "apoa.exported", after: { guests: r.guests.length }, occurredAt: new Date() })),
    );
  }
  return new Response(csv(lines), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="apoa-${property.slug}-${from}-${to}.csv"`,
      "cache-control": "private, no-store",
    },
  });
}
