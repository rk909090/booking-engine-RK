"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { approveDateChange, declineDateChange } from "@/domain/date-change";
import { hasLocale, type Locale } from "@/i18n/config";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { deliverSoon } from "@/lib/notifications/deliver";

/* A guest's date change request, decided from the reservation page (front office and branch managers). */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(form: FormData, key: string) {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

async function context(form: FormData) {
  const langRaw = field(form, "lang");
  const lang: Locale = hasLocale(langRaw) ? langRaw : "id";
  const code = field(form, "code").toUpperCase().slice(0, 40);
  const back = (query: string): never => {
    refresh();
    redirect(`/${lang}/ops/reservations/${encodeURIComponent(code)}?${query}#date-change`);
  };
  const staff = await requireStaff(lang);
  const [r] = await getDb().select({ id: schema.reservations.id, propertyId: schema.reservations.propertyId, unitId: schema.reservations.unitId }).from(schema.reservations).where(eq(schema.reservations.code, code)).limit(1);
  if (!r || !can(staff.actor, "reservation.view", r.propertyId).allowed) back("error=not_found");
  if (!can(staff.actor, "reservation.modify", r.propertyId).allowed) back("error=role");
  return { staff, r: r!, back };
}

export async function approveDateChangeAction(form: FormData) {
  const { staff, r, back } = await context(form);
  const unitId = UUID.test(field(form, "unitId")) ? field(form, "unitId") : r.unitId;
  if (unitId !== r.unitId && !can(staff.actor, "reservation.move", r.propertyId).allowed) back("error=role");
  const result = await approveDateChange(getDb(), { reservationId: r.id, unitId, actor: { type: "staff", id: staff.staffId } });
  if (result.ok) deliverSoon();
  back(result.ok ? "done=1" : `error=datechange_${result.error}`);
}

export async function declineDateChangeAction(form: FormData) {
  const { staff, r, back } = await context(form);
  const result = await declineDateChange(getDb(), { reservationId: r.id, reason: field(form, "reason"), actor: { type: "staff", id: staff.staffId } });
  if (result.ok) deliverSoon();
  back(result.ok ? "done=1" : `error=datechange_${result.error}`);
}
