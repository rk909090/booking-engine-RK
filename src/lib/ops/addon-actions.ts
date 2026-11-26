"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { addAddonByStaff, cancelAddonOrder, confirmAddonOrder, declineAddonOrder, type AddonError } from "@/domain/addons";
import { hasLocale, type Locale } from "@/i18n/config";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { parseAddonChoice } from "@/lib/addon-input";
import { deliverSoon } from "@/lib/notifications/deliver";

/*
 * Add-on orders from the reservation page: confirm or decline a guest's
 * request, cancel a confirmed order, or add one for the guest. Each re-checks
 * the session and the role at the booking's property.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(form: FormData, key: string) {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

async function onReservation(form: FormData, op: (ctx: { reservationId: string; actor: { type: "staff"; id: string } }) => Promise<{ ok: true } | { ok: false; error: AddonError }>) {
  const langRaw = field(form, "lang");
  const lang: Locale = hasLocale(langRaw) ? langRaw : "id";
  const code = field(form, "code").toUpperCase().slice(0, 40);
  const back = (query: string): never => {
    refresh();
    redirect(`/${lang}/ops/reservations/${encodeURIComponent(code)}?${query}#addons`);
  };
  const staff = await requireStaff(lang);
  const [r] = await getDb().select({ id: schema.reservations.id, propertyId: schema.reservations.propertyId }).from(schema.reservations).where(eq(schema.reservations.code, code)).limit(1);
  if (!r || !can(staff.actor, "reservation.view", r.propertyId).allowed) back("error=not_found");
  if (!can(staff.actor, "addon.manage", r.propertyId).allowed) back("error=role");
  const result = await op({ reservationId: r.id, actor: { type: "staff", id: staff.staffId } });
  if (result.ok) deliverSoon();
  back(result.ok ? "done=1" : `error=addon_${result.error}`);
}

/** The order must belong to the booking on this page. */
async function orderOf(reservationId: string, orderId: string) {
  if (!UUID.test(orderId)) return false;
  const [o] = await getDb().select({ reservationId: schema.addonOrders.reservationId }).from(schema.addonOrders).where(eq(schema.addonOrders.id, orderId));
  return o?.reservationId === reservationId;
}

export async function confirmAddonAction(form: FormData) {
  const orderId = field(form, "orderId");
  await onReservation(form, async ({ reservationId, actor }) => ((await orderOf(reservationId, orderId)) ? confirmAddonOrder(getDb(), { orderId, actor }) : { ok: false, error: "not_found" }));
}

export async function declineAddonAction(form: FormData) {
  const orderId = field(form, "orderId");
  await onReservation(form, async ({ reservationId, actor }) => ((await orderOf(reservationId, orderId)) ? declineAddonOrder(getDb(), { orderId, reason: field(form, "reason"), actor }) : { ok: false, error: "not_found" }));
}

export async function cancelAddonAction(form: FormData) {
  const orderId = field(form, "orderId");
  await onReservation(form, async ({ reservationId, actor }) => ((await orderOf(reservationId, orderId)) ? cancelAddonOrder(getDb(), { orderId, reason: field(form, "reason"), actor }) : { ok: false, error: "not_found" }));
}

export async function addAddonAction(form: FormData) {
  const addonId = field(form, "addonId");
  await onReservation(form, async ({ reservationId, actor }) => {
    if (!UUID.test(addonId)) return { ok: false, error: "not_found" };
    const result = await addAddonByStaff(getDb(), { reservationId, choice: parseAddonChoice(form, "", addonId), actor });
    return result.ok ? { ok: true } : result;
  });
}
