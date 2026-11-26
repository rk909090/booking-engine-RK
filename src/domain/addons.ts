import { and, asc, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { diffDays, isIsoDate } from "./dates";
import { addCharge, voidCharge } from "./folio";
import { queueGuestMessage } from "./notifications";
import type { LocalizedText } from "./types";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Tx = Parameters<Parameters<AnyDb["transaction"]>[0]>[0];
type Executor = AnyDb | Tx;
type Actor = { type: "staff"; id: string };
type Addon = typeof schema.addons.$inferSelect;
type Reservation = typeof schema.reservations.$inferSelect;

/*
 * Add-ons and experiences (rules agreed with the owner, 26 Nov 2026):
 * - priced per booking (a quantity), per person, per night, or per person
 *   per night; prices include tax and service like other charges;
 * - ordered at checkout (they join the booking total, so the deposit covers
 *   them), from the guest's booking page, or by staff;
 * - staff confirm or decline each guest order. A confirmed order becomes a
 *   task on the board and a charge on the bill (checkout orders are charged
 *   from the start); a declined checkout order is taken off the bill, with
 *   a refund owed if it was already paid. Staff orders are confirmed at once.
 */

export const ADDON_PRICING = schema.ADDON_PRICING;
export type AddonPricing = (typeof ADDON_PRICING)[number];
export const MAX_ADDON_QUANTITY = 20;

/** Units charged for an order: the quantity, persons, nights, or persons × nights. */
export function addonUnits(pricing: AddonPricing | string, counts: { persons: number; nights: number; quantity: number }): number {
  switch (pricing) {
    case "per_person":
      return counts.persons;
    case "per_night":
      return counts.nights;
    case "per_person_night":
      return counts.persons * counts.nights;
    default:
      return counts.quantity;
  }
}

/** Local date and time at the property, "YYYY-MM-DDTHH:MM". */
export function localNow(timeZone: string, now: Date = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export type AddonChoice = {
  addonId: string;
  serviceDate: string;
  serviceTime?: string | null;
  persons?: number;
  nights?: number;
  quantity?: number;
  note?: string | null;
};

export type AddonError =
  | "not_found"
  | "not_allowed"
  | "invalid_date"
  | "invalid_time"
  | "too_late"
  | "invalid_count"
  | "already_decided"
  | "reason_required"
  | "charge_failed";

type Stay = Pick<Reservation, "checkIn" | "checkOut" | "adults" | "children">;
type Checked = { persons: number; nights: number; quantity: number; units: number; amount: number; serviceDate: string; serviceTime: string | null; note: string | null };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Checks a choice against the stay: a service date within the stay
 * (departure day included), a time when the add-on needs one, counts within
 * the stay and party, and enough notice (staff may skip the notice).
 */
export function checkChoice(addon: Addon, choice: AddonChoice, stay: Stay, opts: { timezone: string; now: Date; skipLeadTime?: boolean }): { ok: true; value: Checked } | { ok: false; error: AddonError } {
  if (!isIsoDate(choice.serviceDate) || choice.serviceDate < stay.checkIn || choice.serviceDate > stay.checkOut) return { ok: false, error: "invalid_date" };
  const time = choice.serviceTime?.trim() || null;
  if (addon.needsTime ? !time || !HHMM.test(time) : time !== null && !HHMM.test(time)) return { ok: false, error: "invalid_time" };
  const guests = stay.adults + stay.children;
  const stayNights = diffDays(stay.checkIn, stay.checkOut);
  const perPerson = addon.pricing === "per_person" || addon.pricing === "per_person_night";
  const perNight = addon.pricing === "per_night" || addon.pricing === "per_person_night";
  const persons = perPerson ? Number(choice.persons ?? guests) : 1;
  const nights = perNight ? Number(choice.nights ?? stayNights) : 1;
  const quantity = addon.pricing === "per_booking" ? Number(choice.quantity ?? 1) : 1;
  if (![persons, nights, quantity].every(Number.isInteger) || persons < 1 || persons > guests || nights < 1 || nights > stayNights || quantity < 1 || quantity > MAX_ADDON_QUANTITY) {
    return { ok: false, error: "invalid_count" };
  }
  if (!opts.skipLeadTime) {
    const service = Date.parse(`${choice.serviceDate}T${time ?? "00:00"}:00Z`);
    const current = Date.parse(`${localNow(opts.timezone, opts.now)}:00Z`);
    if (service - current < addon.leadHours * 3_600_000) return { ok: false, error: "too_late" };
  }
  const units = addonUnits(addon.pricing, { persons, nights, quantity });
  return { ok: true, value: { persons, nights, quantity, units, amount: units * addon.price, serviceDate: choice.serviceDate, serviceTime: time, note: choice.note?.trim().slice(0, 500) || null } };
}

/** The charge line on the bill: name, then when and for how many. */
export function chargeDescription(addon: Addon, v: Pick<Checked, "serviceDate" | "serviceTime" | "persons" | "nights" | "quantity">): string {
  const counts = addon.pricing === "per_person" ? ` · ${v.persons}p` : addon.pricing === "per_night" ? ` · ${v.nights}n` : addon.pricing === "per_person_night" ? ` · ${v.persons}p × ${v.nights}n` : "";
  return `${addon.name.id} · ${v.serviceDate}${v.serviceTime ? ` ${v.serviceTime.slice(0, 5)}` : ""}${counts}`.slice(0, 200);
}

export async function activeAddons(db: Executor, propertyId: string) {
  return db.select().from(schema.addons).where(and(eq(schema.addons.propertyId, propertyId), eq(schema.addons.isActive, true))).orderBy(asc(schema.addons.sortOrder), asc(schema.addons.createdAt));
}

async function loadAddons(db: Executor, propertyId: string, ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(schema.addons).where(and(eq(schema.addons.propertyId, propertyId), inArray(schema.addons.id, ids), eq(schema.addons.isActive, true)));
}

/**
 * Checks the add-ons chosen at checkout before a hold is made. Returns the
 * checked choices and their total (added to the booking total).
 */
export type CheckedAddons = { ok: true; checked: Array<{ addon: Addon; value: Checked }>; total: number } | { ok: false; error: AddonError };

export async function checkCheckoutAddons(db: Executor, input: { propertyId: string; stay: Stay; choices: AddonChoice[]; timezone: string; now: Date }): Promise<CheckedAddons> {
  const addons = await loadAddons(db, input.propertyId, [...new Set(input.choices.map((c) => c.addonId))]);
  const checked: Array<{ addon: Addon; value: Checked }> = [];
  for (const choice of input.choices) {
    const addon = addons.find((a) => a.id === choice.addonId);
    if (!addon) return { ok: false, error: "not_found" };
    const c = checkChoice(addon, choice, input.stay, { timezone: input.timezone, now: input.now });
    if (!c.ok) return { ok: false, error: c.error };
    checked.push({ addon, value: c.value });
  }
  return { ok: true, checked, total: checked.reduce((s, x) => s + x.value.amount, 0) };
}

/** Records checkout add-ons on a new hold: a charge on the bill and a requested order for each. Runs in the hold's transaction. */
export async function recordCheckoutAddons(tx: Tx, reservation: Reservation, checked: Array<{ addon: Addon; value: Checked }>, now: Date) {
  for (const { addon, value } of checked) {
    const [charge] = await tx
      .insert(schema.folioCharges)
      .values({
        reservationId: reservation.id,
        category: addon.category,
        description: chargeDescription(addon, value),
        quantity: value.units,
        unitPrice: addon.price,
        amount: value.amount,
        chargeDate: value.serviceDate,
        createdBy: "guest",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.folioCharges.id });
    await tx.insert(schema.addonOrders).values({ reservationId: reservation.id, addonId: addon.id, source: "checkout", ...value, unitPrice: addon.price, folioChargeId: charge.id, createdAt: now, updatedAt: now });
  }
}

async function reservationRow(db: Executor, reservationId: string) {
  const [row] = await db
    .select({ r: schema.reservations, timezone: schema.properties.timezone })
    .from(schema.reservations)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .where(eq(schema.reservations.id, reservationId));
  return row ?? null;
}

const ORDERABLE: Reservation["status"][] = ["confirmed", "in_house"];

/** A guest asks for an add-on from their booking page; staff confirm it later. */
export async function requestAddonAsGuest(db: AnyDb, input: { reservationId: string; choice: AddonChoice; now?: Date }): Promise<{ ok: true; orderId: string } | { ok: false; error: AddonError }> {
  const now = input.now ?? new Date();
  const row = await reservationRow(db, input.reservationId);
  if (!row) return { ok: false, error: "not_found" };
  if (!ORDERABLE.includes(row.r.status)) return { ok: false, error: "not_allowed" };
  const [addon] = await loadAddons(db, row.r.propertyId, [input.choice.addonId]);
  if (!addon) return { ok: false, error: "not_found" };
  const c = checkChoice(addon, input.choice, row.r, { timezone: row.timezone, now });
  if (!c.ok) return c;
  const [order] = await db
    .insert(schema.addonOrders)
    .values({ reservationId: row.r.id, addonId: addon.id, source: "portal", ...c.value, unitPrice: addon.price, createdAt: now, updatedAt: now })
    .returning({ id: schema.addonOrders.id });
  await db.insert(schema.auditEvents).values({ actorType: "guest", propertyId: row.r.propertyId, entityType: "reservation", entityId: row.r.id, action: "addon.requested", after: { orderId: order.id, addon: addon.name.en, amount: c.value.amount }, occurredAt: now });
  return { ok: true, orderId: order.id };
}

/** A guest withdraws a request that staff have not decided on yet. */
export async function cancelAddonAsGuest(db: AnyDb, input: { reservationId: string; orderId: string; now?: Date }): Promise<{ ok: true } | { ok: false; error: AddonError }> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(schema.addonOrders)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(schema.addonOrders.id, input.orderId), eq(schema.addonOrders.reservationId, input.reservationId), eq(schema.addonOrders.status, "requested"), eq(schema.addonOrders.source, "portal")))
    .returning({ id: schema.addonOrders.id });
  if (!updated.length) return { ok: false, error: "already_decided" };
  const row = await reservationRow(db, input.reservationId);
  await db.insert(schema.auditEvents).values({ actorType: "guest", propertyId: row?.r.propertyId ?? null, entityType: "reservation", entityId: input.reservationId, action: "addon.withdrawn", after: { orderId: input.orderId }, occurredAt: now });
  return { ok: true };
}

async function loadOrder(db: Executor, orderId: string) {
  const [row] = await db
    .select({ order: schema.addonOrders, addon: schema.addons, r: schema.reservations })
    .from(schema.addonOrders)
    .innerJoin(schema.addons, eq(schema.addons.id, schema.addonOrders.addonId))
    .innerJoin(schema.reservations, eq(schema.reservations.id, schema.addonOrders.reservationId))
    .where(eq(schema.addonOrders.id, orderId));
  return row ?? null;
}

/**
 * Confirms an order: it is charged (if it was not already, as checkout
 * orders are), becomes a task due at the service time, and the guest is told.
 */
export async function confirmAddonOrder(db: AnyDb, input: { orderId: string; actor: Actor; notify?: boolean; now?: Date }): Promise<{ ok: true } | { ok: false; error: AddonError }> {
  const now = input.now ?? new Date();
  const row = await loadOrder(db, input.orderId);
  if (!row) return { ok: false, error: "not_found" };
  const { order, addon, r } = row;
  if (order.status !== "requested") return { ok: false, error: "already_decided" };
  if (!ORDERABLE.includes(r.status) && r.status !== "hold") return { ok: false, error: "not_allowed" };
  let chargeId = order.folioChargeId;
  if (!chargeId) {
    const charged = await addCharge(db, { reservationId: r.id, category: addon.category, description: chargeDescription(addon, order), quantity: order.units, unitPrice: order.unitPrice, actor: input.actor, now });
    if (!charged.ok) return { ok: false, error: "charge_failed" };
    chargeId = charged.chargeId;
  }
  return db.transaction(async (tx) => {
    const [task] = await tx
      .insert(schema.tasks)
      .values({
        propertyId: r.propertyId,
        unitId: r.unitId,
        reservationId: r.id,
        kind: "request",
        source: `addon:${order.id}`,
        title: `${addon.name.id}${order.serviceTime ? ` · ${order.serviceTime.slice(0, 5)}` : ""}`,
        notes: [chargeDescription(addon, order), order.note].filter(Boolean).join("\n"),
        dueDate: order.serviceDate,
        dueTime: order.serviceTime,
        createdBy: input.actor.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.tasks.id });
    const updated = await tx
      .update(schema.addonOrders)
      .set({ status: "confirmed", folioChargeId: chargeId, taskId: task.id, decidedBy: input.actor.id, decidedAt: now, updatedAt: now })
      .where(and(eq(schema.addonOrders.id, order.id), eq(schema.addonOrders.status, "requested")))
      .returning({ id: schema.addonOrders.id });
    if (!updated.length) throw new Error("addon order changed while confirming");
    await tx.insert(schema.auditEvents).values({ actorType: "staff", actorId: input.actor.id, propertyId: r.propertyId, entityType: "reservation", entityId: r.id, action: "addon.confirmed", after: { orderId: order.id, addon: addon.name.en, amount: order.amount }, occurredAt: now });
    if (input.notify !== false && r.status !== "hold") {
      await queueGuestMessage(tx, { reservationId: r.id, kind: "addon_decided", payload: { approved: true, addon: addon.name, date: order.serviceDate, time: order.serviceTime?.slice(0, 5) ?? null, amount: order.amount }, dedupe: `addon:${order.id}`, now });
    }
    return { ok: true } as const;
  });
}

/** Declines a guest's order; a checkout order already on the bill is taken off it (refund owed if paid). */
export async function declineAddonOrder(db: AnyDb, input: { orderId: string; reason: string; actor: Actor; now?: Date }): Promise<{ ok: true } | { ok: false; error: AddonError }> {
  const now = input.now ?? new Date();
  const reason = input.reason.trim().slice(0, 300);
  if (!reason) return { ok: false, error: "reason_required" };
  const row = await loadOrder(db, input.orderId);
  if (!row) return { ok: false, error: "not_found" };
  const { order, addon, r } = row;
  if (order.status !== "requested") return { ok: false, error: "already_decided" };
  if (order.folioChargeId) {
    const voided = await voidCharge(db, { reservationId: r.id, chargeId: order.folioChargeId, reason, actor: input.actor, now });
    if (!voided.ok && voided.error !== "already_void") return { ok: false, error: "charge_failed" };
  }
  await db.transaction(async (tx) => {
    await tx.update(schema.addonOrders).set({ status: "declined", declineReason: reason, decidedBy: input.actor.id, decidedAt: now, updatedAt: now }).where(eq(schema.addonOrders.id, order.id));
    await tx.insert(schema.auditEvents).values({ actorType: "staff", actorId: input.actor.id, propertyId: r.propertyId, entityType: "reservation", entityId: r.id, action: "addon.declined", after: { orderId: order.id, addon: addon.name.en, reason }, occurredAt: now });
    if (r.status === "confirmed" || r.status === "in_house") {
      await queueGuestMessage(tx, { reservationId: r.id, kind: "addon_decided", payload: { approved: false, addon: addon.name, date: order.serviceDate, time: order.serviceTime?.slice(0, 5) ?? null }, dedupe: `addon:${order.id}`, now });
    }
  });
  return { ok: true };
}

/** Cancels a confirmed order (plans changed): the charge comes off the bill and the task is cancelled. */
export async function cancelAddonOrder(db: AnyDb, input: { orderId: string; reason: string; actor: Actor; now?: Date }): Promise<{ ok: true } | { ok: false; error: AddonError }> {
  const now = input.now ?? new Date();
  const reason = input.reason.trim().slice(0, 300);
  if (!reason) return { ok: false, error: "reason_required" };
  const row = await loadOrder(db, input.orderId);
  if (!row) return { ok: false, error: "not_found" };
  const { order, r } = row;
  if (order.status !== "confirmed") return { ok: false, error: "already_decided" };
  if (order.folioChargeId) {
    const voided = await voidCharge(db, { reservationId: r.id, chargeId: order.folioChargeId, reason, actor: input.actor, now });
    if (!voided.ok && voided.error !== "already_void") return { ok: false, error: "charge_failed" };
  }
  await db.update(schema.addonOrders).set({ status: "cancelled", declineReason: reason, updatedAt: now }).where(eq(schema.addonOrders.id, order.id));
  if (order.taskId) {
    await db.update(schema.tasks).set({ status: "cancelled", completedAt: now, completedBy: input.actor.id, updatedAt: now }).where(and(eq(schema.tasks.id, order.taskId), inArray(schema.tasks.status, ["open", "in_progress"])));
  }
  await db.insert(schema.auditEvents).values({ actorType: "staff", actorId: input.actor.id, propertyId: r.propertyId, entityType: "reservation", entityId: r.id, action: "addon.cancelled", after: { orderId: order.id, reason }, occurredAt: now });
  return { ok: true };
}

/** Staff add an add-on for the guest (phone, WhatsApp, at the desk): confirmed at once, notice period not enforced. */
export async function addAddonByStaff(db: AnyDb, input: { reservationId: string; choice: AddonChoice; actor: Actor; now?: Date }): Promise<{ ok: true; orderId: string } | { ok: false; error: AddonError }> {
  const now = input.now ?? new Date();
  const row = await reservationRow(db, input.reservationId);
  if (!row) return { ok: false, error: "not_found" };
  if (!ORDERABLE.includes(row.r.status)) return { ok: false, error: "not_allowed" };
  const [addon] = await loadAddons(db, row.r.propertyId, [input.choice.addonId]);
  if (!addon) return { ok: false, error: "not_found" };
  const c = checkChoice(addon, input.choice, row.r, { timezone: row.timezone, now, skipLeadTime: true });
  if (!c.ok) return c;
  const [order] = await db
    .insert(schema.addonOrders)
    .values({ reservationId: row.r.id, addonId: addon.id, source: "staff", ...c.value, unitPrice: addon.price, createdAt: now, updatedAt: now })
    .returning({ id: schema.addonOrders.id });
  const confirmed = await confirmAddonOrder(db, { orderId: order.id, actor: input.actor, notify: false, now });
  if (!confirmed.ok) {
    await db.delete(schema.addonOrders).where(eq(schema.addonOrders.id, order.id));
    return confirmed;
  }
  return { ok: true, orderId: order.id };
}

/** Orders of a booking, newest first, with the add-on. */
export async function addonOrdersFor(db: Executor, reservationId: string) {
  return db
    .select({ order: schema.addonOrders, addon: schema.addons })
    .from(schema.addonOrders)
    .innerJoin(schema.addons, eq(schema.addons.id, schema.addonOrders.addonId))
    .where(eq(schema.addonOrders.reservationId, reservationId))
    .orderBy(asc(schema.addonOrders.serviceDate), asc(schema.addonOrders.createdAt));
}

/** Requests waiting for a decision at these properties (for the home page and the reservation list). */
export async function pendingAddonCount(db: Executor, propertyIds: readonly string[] | null) {
  const rows = await db
    .select({ id: schema.addonOrders.id })
    .from(schema.addonOrders)
    .innerJoin(schema.reservations, eq(schema.reservations.id, schema.addonOrders.reservationId))
    .where(and(eq(schema.addonOrders.status, "requested"), inArray(schema.reservations.status, ["confirmed", "in_house"]), propertyIds ? inArray(schema.reservations.propertyId, [...propertyIds]) : undefined));
  return rows.length;
}

export type AddonInput = {
  propertyId: string;
  name: LocalizedText;
  description: LocalizedText | null;
  category: string;
  pricing: string;
  price: number;
  needsTime: boolean;
  leadHours: number;
  sortOrder: number;
  actor: Actor;
};

function validAddon(input: Omit<AddonInput, "actor" | "propertyId">): boolean {
  const name = { id: input.name.id.trim(), en: input.name.en.trim() };
  return (
    name.id.length >= 2 &&
    name.id.length <= 80 &&
    name.en.length >= 2 &&
    name.en.length <= 80 &&
    (schema.folioCategories as readonly string[]).includes(input.category) &&
    (ADDON_PRICING as readonly string[]).includes(input.pricing) &&
    Number.isSafeInteger(input.price) &&
    input.price > 0 &&
    input.price <= 1_000_000_000 &&
    Number.isInteger(input.leadHours) &&
    input.leadHours >= 0 &&
    input.leadHours <= 720 &&
    Number.isInteger(input.sortOrder)
  );
}

const cleanText = (t: LocalizedText | null) => (t && (t.id.trim() || t.en.trim()) ? { id: t.id.trim().slice(0, 500), en: t.en.trim().slice(0, 500) } : null);

/** Adds an add-on to a property's catalog (branch managers). */
export async function createAddon(db: AnyDb, input: AddonInput): Promise<{ ok: true; id: string } | { ok: false; error: "invalid" }> {
  if (!validAddon(input)) return { ok: false, error: "invalid" };
  const [row] = await db
    .insert(schema.addons)
    .values({
      propertyId: input.propertyId,
      name: { id: input.name.id.trim(), en: input.name.en.trim() },
      description: cleanText(input.description),
      category: input.category,
      pricing: input.pricing,
      price: input.price,
      needsTime: input.needsTime,
      leadHours: input.leadHours,
      sortOrder: input.sortOrder,
      createdBy: input.actor.id,
    })
    .returning({ id: schema.addons.id });
  await db.insert(schema.auditEvents).values({ actorType: "staff", actorId: input.actor.id, propertyId: input.propertyId, entityType: "addon", entityId: row.id, action: "addon.created", after: { name: input.name.en, pricing: input.pricing, price: input.price }, occurredAt: new Date() });
  return { ok: true, id: row.id };
}

/** Changes an add-on; orders already placed keep their price. */
export async function updateAddon(db: AnyDb, input: AddonInput & { addonId: string; isActive: boolean }): Promise<{ ok: true } | { ok: false; error: "invalid" | "not_found" }> {
  if (!validAddon(input)) return { ok: false, error: "invalid" };
  const updated = await db
    .update(schema.addons)
    .set({
      name: { id: input.name.id.trim(), en: input.name.en.trim() },
      description: cleanText(input.description),
      category: input.category,
      pricing: input.pricing,
      price: input.price,
      needsTime: input.needsTime,
      leadHours: input.leadHours,
      sortOrder: input.sortOrder,
      isActive: input.isActive,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.addons.id, input.addonId), eq(schema.addons.propertyId, input.propertyId)))
    .returning({ id: schema.addons.id });
  if (!updated.length) return { ok: false, error: "not_found" };
  await db.insert(schema.auditEvents).values({ actorType: "staff", actorId: input.actor.id, propertyId: input.propertyId, entityType: "addon", entityId: input.addonId, action: "addon.updated", after: { name: input.name.en, price: input.price, active: input.isActive }, occurredAt: new Date() });
  return { ok: true };
}
