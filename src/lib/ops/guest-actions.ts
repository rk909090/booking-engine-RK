"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { anonymizeGuest, markApoaReported, mergeGuests, updateGuest, type GuestsResult } from "@/domain/guests";
import { hasLocale, type Locale } from "@/i18n/config";
import { requireStaff } from "@/lib/auth/current-staff";
import { can, type Action } from "@/lib/authz/permissions";
import * as schema from "@/db/schema";
import { inArray } from "drizzle-orm";
import { guestScope } from "./guest-access";

/*
 * Guest profile and APOA actions. Each re-checks the session, that the
 * guest is visible to this staff member, and the role at one of the
 * guest's properties; then returns to the page with a short outcome code.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(form: FormData, key: string) {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function langOf(form: FormData): Locale {
  const raw = field(form, "lang");
  return hasLocale(raw) ? raw : "id";
}

async function onGuest(form: FormData, action: Action, op: (ctx: { guestId: string; actor: { type: "staff"; id: string } }) => Promise<GuestsResult | { ok: true; redirectTo?: string }>) {
  const lang = langOf(form);
  const guestId = field(form, "guestId");
  const anchor = field(form, "anchor");
  const back = (path: string, query: string): never => {
    refresh();
    redirect(`${path}?${query}${/^[a-z0-9-]+$/i.test(anchor) ? `#${anchor}` : ""}`);
  };
  const profile = `/${lang}/ops/guests/${UUID.test(guestId) ? guestId : ""}`;
  const staff = await requireStaff(lang);
  if (!UUID.test(guestId)) back(`/${lang}/ops/guests`, "error=not_found");
  const scope = await guestScope(staff.actor, guestId);
  if (!scope.visible) back(`/${lang}/ops/guests`, "error=not_found");
  if (!scope.propertyIds.some((p) => can(staff.actor, action, p).allowed)) back(profile, "error=role");
  const result = await op({ guestId, actor: { type: "staff", id: staff.staffId } });
  if (result.ok) back("redirectTo" in result && result.redirectTo ? result.redirectTo : profile, "done=1");
  const failed = result as Extract<GuestsResult, { ok: false }>;
  back(profile, `error=${failed.error}${failed.otherId ? `&other=${failed.otherId}` : ""}`);
}

export async function updateGuestAction(form: FormData) {
  await onGuest(form, "guest.edit", ({ guestId, actor }) =>
    updateGuest(getDb(), {
      guestId,
      fullName: field(form, "fullName"),
      email: field(form, "email") || null,
      phone: field(form, "phone") || null,
      countryCode: field(form, "country") || null,
      notes: field(form, "notes") || null,
      tags: form.getAll("tags").filter((v): v is string => typeof v === "string"),
      actor,
    }),
  );
}

/** Merges another profile into this one; the other must be visible to this staff member too. */
export async function mergeGuestAction(form: FormData) {
  const removeId = field(form, "removeId");
  await onGuest(form, "guest.merge", async ({ guestId, actor }) => {
    if (!UUID.test(removeId)) return { ok: false, error: "not_found" };
    const staff = await requireStaff(langOf(form));
    if (!(await guestScope(staff.actor, removeId)).visible) return { ok: false, error: "not_found" };
    return mergeGuests(getDb(), { keepId: guestId, removeId, actor });
  });
}

export async function anonymizeGuestAction(form: FormData) {
  await onGuest(form, "guest.privacy", ({ guestId, actor }) =>
    form.get("confirm") === "on" ? anonymizeGuest(getDb(), { guestId, actor }) : Promise.resolve({ ok: false, error: "invalid" } as const),
  );
}

/** Marks the chosen bookings as reported to immigration (APOA), or clears the mark. */
export async function apoaReportAction(form: FormData) {
  const lang = langOf(form);
  const back = (query: string): never => {
    refresh();
    const params = new URLSearchParams();
    for (const k of ["property", "from", "to"]) if (field(form, k)) params.set(k, field(form, k));
    redirect(`/${lang}/ops/immigration?${params.toString()}&${query}`);
  };
  const staff = await requireStaff(lang);
  const ids = form.getAll("reservationId").filter((v): v is string => typeof v === "string" && UUID.test(v));
  if (!ids.length) back("error=none_selected");
  const rows = await getDb().select({ id: schema.reservations.id, propertyId: schema.reservations.propertyId }).from(schema.reservations).where(inArray(schema.reservations.id, ids));
  if (rows.length !== ids.length || rows.some((r) => !can(staff.actor, "guest.apoa", r.propertyId).allowed)) back("error=role");
  await markApoaReported(getDb(), { reservationIds: ids, reported: field(form, "reported") !== "0", actor: { type: "staff", id: staff.staffId } });
  back("done=1");
}
