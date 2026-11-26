"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { addSubscription, removeSubscription } from "@/domain/report-schedule";
import { hasLocale, type Locale } from "@/i18n/config";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";

/* Recipients of the scheduled reports (branch managers of the property). */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(form: FormData, key: string) {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

async function guard(form: FormData, propertyIdOf: () => Promise<string | null>) {
  const langRaw = field(form, "lang");
  const lang: Locale = hasLocale(langRaw) ? langRaw : "id";
  const property = field(form, "property");
  const back = (query: string): never => {
    refresh();
    redirect(`/${lang}/ops/reports/schedules?${property ? `property=${encodeURIComponent(property)}&` : ""}${query}#${field(form, "kind") || "recipients"}`);
  };
  const staff = await requireStaff(lang);
  const propertyId = await propertyIdOf();
  if (!propertyId) back("error=not_found");
  if (!can(staff.actor, "reports.schedule", propertyId!).allowed) back("error=role");
  return { staff, propertyId: propertyId!, back };
}

export async function addRecipientAction(form: FormData) {
  const propertyIdRaw = field(form, "propertyId");
  const { staff, propertyId, back } = await guard(form, async () => {
    if (!UUID.test(propertyIdRaw)) return null;
    const [p] = await getDb().select({ id: schema.properties.id }).from(schema.properties).where(eq(schema.properties.id, propertyIdRaw));
    return p?.id ?? null;
  });
  const who = field(form, "who");
  const result = await addSubscription(getDb(), {
    propertyId,
    kind: field(form, "kind"),
    staffId: UUID.test(who) ? who : null,
    email: UUID.test(who) ? null : field(form, "email") || null,
    locale: field(form, "locale"),
    actor: { type: "staff", id: staff.staffId },
  });
  back(result.ok ? "done=1" : `error=${result.error}`);
}

export async function removeRecipientAction(form: FormData) {
  const id = field(form, "subscriptionId");
  const { staff, back } = await guard(form, async () => {
    if (!UUID.test(id)) return null;
    const [s] = await getDb().select({ propertyId: schema.reportSubscriptions.propertyId }).from(schema.reportSubscriptions).where(eq(schema.reportSubscriptions.id, id));
    return s?.propertyId ?? null;
  });
  const result = await removeSubscription(getDb(), { subscriptionId: id, actor: { type: "staff", id: staff.staffId } });
  back(result.ok ? "done=1" : `error=${result.error}`);
}
