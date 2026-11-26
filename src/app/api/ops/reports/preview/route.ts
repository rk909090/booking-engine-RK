import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { todayIn } from "@/domain/dates";
import { REPORT_KINDS, type ReportKind } from "@/domain/report-schedule";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { buildReportEmail } from "@/lib/ops/report-delivery";
import { XLSX_TYPE } from "@/lib/xlsx";

/**
 * Preview of a scheduled report as it would be sent today:
 * /api/ops/reports/preview?property=&kind=daily|weekly|monthly&locale=id|en,
 * with file=0, 1, ... for an attachment. Directors and branch managers.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const staff = await requireStaff("id");
  const kind = url.searchParams.get("kind") ?? "";
  const locale = url.searchParams.get("locale") === "en" ? "en" : "id";
  const [property] = await getDb().select().from(schema.properties).where(eq(schema.properties.slug, url.searchParams.get("property") ?? ""));
  if (!property || !(REPORT_KINDS as readonly string[]).includes(kind)) return new Response("Not found", { status: 404 });
  if (!can(staff.actor, "performance.view", property.id).allowed) return new Response("Forbidden", { status: 403 });
  const email = await buildReportEmail(property, kind as ReportKind, todayIn(property.timezone), locale);
  const file = url.searchParams.get("file");
  if (file !== null) {
    const attachment = email.attachments[Number(file)];
    if (!attachment) return new Response("Not found", { status: 404 });
    return new Response(Buffer.from(attachment.content, "base64"), { headers: { "content-type": XLSX_TYPE, "content-disposition": `attachment; filename="${attachment.filename}"`, "cache-control": "private, no-store" } });
  }
  return new Response(email.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:" } });
}
