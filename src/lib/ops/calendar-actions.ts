"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { applyStayChange, previewStayChange, type StayChangeResult } from "@/domain/modify";
import { hasLocale, type Locale } from "@/i18n/config";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { deliverSoon } from "@/lib/notifications/deliver";

/*
 * Drag and drop on the calendar. The browser sends what was dropped; the
 * server checks the session, role and property scope, previews the change
 * with the same rules as the reservation page, and saves only a confirmed
 * preview (refused if the price moved in between).
 */

export type CalendarMove = { lang: string; code: string; checkIn: string; checkOut: string; unitId: string };

export type CalendarPreview =
  | (StayChangeResult & { before?: { checkIn: string; checkOut: string; unitId: string; nights: string[] } })
  | { ok: false; error: "role" };

type Loaded =
  | { error: "not_found" | "role" }
  | {
      r: { id: string; propertyId: string; unitId: string; checkIn: string; checkOut: string; priceSnapshot: { nights: Array<{ date: string }> } | null };
      staffId: string;
    };

async function load(move: CalendarMove): Promise<Loaded> {
  const lang: Locale = hasLocale(move.lang) ? move.lang : "id";
  const staff = await requireStaff(lang);
  const code = String(move.code).toUpperCase().slice(0, 40);
  const [r] = await getDb()
    .select({
      id: schema.reservations.id,
      propertyId: schema.reservations.propertyId,
      unitId: schema.reservations.unitId,
      checkIn: schema.reservations.checkIn,
      checkOut: schema.reservations.checkOut,
      priceSnapshot: schema.reservations.priceSnapshot,
    })
    .from(schema.reservations)
    .where(eq(schema.reservations.code, code))
    .limit(1);
  if (!r || !can(staff.actor, "reservation.view", r.propertyId).allowed) return { error: "not_found" as const };
  if (!can(staff.actor, "reservation.modify", r.propertyId).allowed) return { error: "role" as const };
  // Moving to another villa is its own permission.
  if (move.unitId !== r.unitId && !can(staff.actor, "reservation.move", r.propertyId).allowed) return { error: "role" as const };
  return { r, staffId: staff.staffId };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function previewCalendarMove(move: CalendarMove): Promise<CalendarPreview> {
  if (!UUID.test(String(move.unitId))) return { ok: false, error: "unit_not_eligible" };
  const loaded = await load(move);
  if ("error" in loaded) return { ok: false, error: loaded.error === "role" ? "role" : "not_found" };
  const { r } = loaded;
  const result = await previewStayChange(getDb(), { reservationId: r.id, checkIn: String(move.checkIn), checkOut: String(move.checkOut), unitId: move.unitId });
  return {
    ...result,
    before: { checkIn: r.checkIn, checkOut: r.checkOut, unitId: r.unitId, nights: r.priceSnapshot?.nights.map((n) => n.date) ?? [] },
  };
}

export async function applyCalendarMove(move: CalendarMove & { expectedTotal: number }): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!UUID.test(String(move.unitId)) || !Number.isSafeInteger(move.expectedTotal)) return { ok: false, error: "invalid_dates" };
  const loaded = await load(move);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  const result = await applyStayChange(getDb(), {
    reservationId: loaded.r.id,
    checkIn: String(move.checkIn),
    checkOut: String(move.checkOut),
    unitId: move.unitId,
    expectedTotal: move.expectedTotal,
    actor: { type: "staff", id: loaded.staffId },
  });
  if (result.ok) deliverSoon();
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
