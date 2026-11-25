"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { todayIn } from "@/domain/dates";
import { eraseExpiredDocuments, revealDocuments } from "@/domain/pre-checkin";
import { hasLocale } from "@/i18n/config";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { openGuestData } from "@/lib/crypto/guest-data";

export type RevealState = { numbers?: Array<{ position: number; documentNumber: string | null }>; error?: "role" | "not_found" };

/**
 * Shows the guests' document numbers in full to the front desk (front office
 * and branch managers, within their properties). Every reveal is logged.
 */
export async function revealDocumentsAction(_prev: RevealState, form: FormData): Promise<RevealState> {
  const langRaw = String(form.get("lang") ?? "id");
  const staff = await requireStaff(hasLocale(langRaw) ? langRaw : "id");
  const code = String(form.get("code") ?? "").toUpperCase().slice(0, 40);
  const [row] = await getDb()
    .select({ id: schema.reservations.id, propertyId: schema.reservations.propertyId, timezone: schema.properties.timezone })
    .from(schema.reservations)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .where(eq(schema.reservations.code, code))
    .limit(1);
  if (!row || !can(staff.actor, "reservation.view", row.propertyId).allowed) return { error: "not_found" };
  if (!can(staff.actor, "reservation.check_in", row.propertyId).allowed) return { error: "role" };
  // Numbers past their retention are erased before anything is shown.
  await eraseExpiredDocuments(getDb(), todayIn(row.timezone));
  const numbers = await revealDocuments(getDb(), { reservationId: row.id, actor: { type: "staff", id: staff.staffId } }, openGuestData);
  return numbers ? { numbers } : { error: "not_found" };
}
