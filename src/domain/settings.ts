import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { setInspectionChecklist } from "./tasks";
import type { CancellationTier, LocalizedText, PropertyContent } from "./types";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Actor = { type: "staff"; id: string };

/*
 * The settings pages (decided with the owner, 26 Nov 2026): property and
 * policies, content and invoice details, villa types and villas. Directors
 * change every property, branch managers their own (checked by the caller).
 * Money rules are saved with each booking, so changes apply to new bookings.
 * Every change is logged with what it was before.
 */

export type SettingsError = "not_found" | "invalid" | "times" | "tiers" | "code_taken" | "has_bookings" | "still_active" | "confirm_name" | "ever_booked" | "has_owner_records";
export type SettingsResult = { ok: true; id?: string } | { ok: false; error: SettingsError };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const intIn = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;

async function audit(db: AnyDb, actor: Actor, propertyId: string, entityType: string, entityId: string, action: string, before: object, after: object) {
  await db.insert(schema.auditEvents).values({ actorType: "staff", actorId: actor.id, propertyId, entityType, entityId, action, before, after, occurredAt: new Date() });
}

export type PolicyInput = {
  propertyId: string;
  checkInTime: string;
  checkOutTime: string;
  taxRateBp: number;
  serviceRateBp: number;
  depositRateBp: number;
  balanceDueDays: number;
  holdMinutes: number;
  turnoverMinutes: number;
  discountLimitFrontOfficeBp: number;
  discountLimitManagerBp: number;
  guestLateCheckoutLatest: string;
  guestEarlyCheckinEarliest: string;
  cancellationTiers: CancellationTier[];
  actor: Actor;
};

/** Tiers sorted from furthest to closest; the charge may only stay or rise as arrival gets closer. */
export function normaliseCancellationTiers(tiers: CancellationTier[]): CancellationTier[] | null {
  if (tiers.length < 1 || tiers.length > 5) return null;
  if (!tiers.every((t) => intIn(t.minDaysBefore, 0, 365) && intIn(t.chargeBp, 0, 10_000))) return null;
  const sorted = [...tiers].sort((a, b) => b.minDaysBefore - a.minDaysBefore);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].minDaysBefore === sorted[i - 1].minDaysBefore || sorted[i].chargeBp < sorted[i - 1].chargeBp) return null;
  }
  return sorted;
}

export async function updatePropertyPolicies(db: AnyDb, input: PolicyInput): Promise<SettingsResult> {
  const [property] = await db.select().from(schema.properties).where(eq(schema.properties.id, input.propertyId));
  if (!property) return { ok: false, error: "not_found" };
  if (![input.checkInTime, input.checkOutTime, input.guestLateCheckoutLatest, input.guestEarlyCheckinEarliest].every((t) => HHMM.test(t))) return { ok: false, error: "times" };
  // Guests leave before the next ones arrive; the guests' own requests stay between those times (see domain/rates.ts).
  if (input.checkOutTime >= input.checkInTime || input.guestLateCheckoutLatest <= input.checkOutTime || input.guestEarlyCheckinEarliest >= input.checkInTime) return { ok: false, error: "times" };
  const numbersOk =
    intIn(input.taxRateBp, 0, 10_000) &&
    intIn(input.serviceRateBp, 0, 10_000) &&
    intIn(input.depositRateBp, 0, 10_000) &&
    intIn(input.balanceDueDays, 0, 365) &&
    intIn(input.holdMinutes, 5, 120) &&
    intIn(input.turnoverMinutes, 0, 720) &&
    intIn(input.discountLimitFrontOfficeBp, 0, 10_000) &&
    intIn(input.discountLimitManagerBp, 0, 10_000);
  if (!numbersOk) return { ok: false, error: "invalid" };
  const tiers = normaliseCancellationTiers(input.cancellationTiers);
  if (!tiers) return { ok: false, error: "tiers" };
  const after = {
    checkInTime: input.checkInTime,
    checkOutTime: input.checkOutTime,
    taxRateBp: input.taxRateBp,
    serviceRateBp: input.serviceRateBp,
    depositRateBp: input.depositRateBp,
    balanceDueDays: input.balanceDueDays,
    holdMinutes: input.holdMinutes,
    turnoverMinutes: input.turnoverMinutes,
    discountLimitFrontOfficeBp: input.discountLimitFrontOfficeBp,
    discountLimitManagerBp: input.discountLimitManagerBp,
    guestLateCheckoutLatest: input.guestLateCheckoutLatest,
    guestEarlyCheckinEarliest: input.guestEarlyCheckinEarliest,
    cancellationTiers: tiers,
  };
  const before = Object.fromEntries(Object.keys(after).map((k) => [k, property[k as keyof typeof property]]));
  await db.update(schema.properties).set({ ...after, updatedAt: new Date() }).where(eq(schema.properties.id, property.id));
  await audit(db, input.actor, property.id, "property", property.id, "settings.policies_updated", before, after);
  return { ok: true };
}

const clean = (s: string | undefined, max: number) => (s ?? "").trim().slice(0, max);
const text = (t: LocalizedText | undefined, max: number): LocalizedText | undefined => {
  const id = clean(t?.id, max);
  const en = clean(t?.en, max);
  return id || en ? { id, en } : undefined;
};
const lines = (s: string[] | undefined) => (s ?? []).map((l) => l.trim().replace(/\s+/g, " ").slice(0, 300)).filter(Boolean).slice(0, 30);

/** What guests read about the property, its house rules, and the seller printed on invoices. */
export async function updatePropertyContent(
  db: AnyDb,
  input: {
    propertyId: string;
    tagline?: LocalizedText;
    description?: LocalizedText;
    houseRules?: { id: string[]; en: string[] };
    invoice?: { legalName?: string; address?: string; taxId?: string; phone?: string; email?: string };
    actor: Actor;
  },
): Promise<SettingsResult> {
  const [property] = await db.select().from(schema.properties).where(eq(schema.properties.id, input.propertyId));
  if (!property) return { ok: false, error: "not_found" };
  const email = clean(input.invoice?.email, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "invalid" };
  const rules = { id: lines(input.houseRules?.id), en: lines(input.houseRules?.en) };
  const invoice = {
    legalName: clean(input.invoice?.legalName, 160) || undefined,
    address: clean(input.invoice?.address, 400) || undefined,
    taxId: clean(input.invoice?.taxId, 40) || undefined,
    phone: clean(input.invoice?.phone, 40) || undefined,
    email: email || undefined,
  };
  const content: PropertyContent = {
    ...property.content,
    tagline: text(input.tagline, 160),
    description: text(input.description, 3000),
    // No rules entered: the general default is used (see pre-check-in).
    houseRules: rules.id.length || rules.en.length ? rules : undefined,
    invoice: Object.values(invoice).some(Boolean) ? invoice : undefined,
  };
  await db.update(schema.properties).set({ content, updatedAt: new Date() }).where(eq(schema.properties.id, property.id));
  await audit(db, input.actor, property.id, "property", property.id, "settings.content_updated", property.content, content);
  return { ok: true };
}

/** A villa type's name, size, description, inspection checklist and whether the website offers it. */
export async function updateUnitTypeDetails(
  db: AnyDb,
  input: { unitTypeId: string; name: string; bedrooms: number; maxGuests: number; summary?: LocalizedText; description?: LocalizedText; isPublished: boolean; checklist: string[]; actor: Actor },
): Promise<SettingsResult> {
  const [type] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.id, input.unitTypeId));
  if (!type) return { ok: false, error: "not_found" };
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80 || !intIn(input.bedrooms, 1, 20) || !intIn(input.maxGuests, 1, 40)) return { ok: false, error: "invalid" };
  const content = { ...type.content, summary: text(input.summary, 300), description: text(input.description, 3000) };
  await db.update(schema.unitTypes).set({ name, bedrooms: input.bedrooms, maxGuests: input.maxGuests, isPublished: input.isPublished, content, updatedAt: new Date() }).where(eq(schema.unitTypes.id, type.id));
  await setInspectionChecklist(db, { unitTypeId: type.id, items: input.checklist, actor: input.actor });
  await audit(
    db,
    input.actor,
    type.propertyId,
    "unit_type",
    type.id,
    "settings.unit_type_updated",
    { name: type.name, bedrooms: type.bedrooms, maxGuests: type.maxGuests, isPublished: type.isPublished },
    { name, bedrooms: input.bedrooms, maxGuests: input.maxGuests, isPublished: input.isPublished },
  );
  return { ok: true };
}

const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

/** A new villa type; its rates, seasons and offers are then set on the rates page. Starts unpublished. */
export async function createUnitType(
  db: AnyDb,
  input: { propertyId: string; name: string; bedrooms: number; maxGuests: number; baseRate: number; actor: Actor },
): Promise<SettingsResult> {
  const [property] = await db.select({ id: schema.properties.id }).from(schema.properties).where(eq(schema.properties.id, input.propertyId));
  if (!property) return { ok: false, error: "not_found" };
  const name = input.name.trim().replace(/\s+/g, " ");
  const base = slugify(name);
  if (name.length < 2 || name.length > 80 || !base || !intIn(input.bedrooms, 1, 20) || !intIn(input.maxGuests, 1, 40) || !Number.isSafeInteger(input.baseRate) || input.baseRate < 0) {
    return { ok: false, error: "invalid" };
  }
  const taken = new Set((await db.select({ slug: schema.unitTypes.slug }).from(schema.unitTypes).where(eq(schema.unitTypes.propertyId, property.id))).map((t) => t.slug));
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${schema.unitTypes.sortOrder}), 0)::int` }).from(schema.unitTypes).where(eq(schema.unitTypes.propertyId, property.id));
  const [created] = await db
    .insert(schema.unitTypes)
    .values({ propertyId: property.id, slug, name, bedrooms: input.bedrooms, maxGuests: input.maxGuests, baseRate: input.baseRate, sortOrder: max + 1, isPublished: false })
    .returning({ id: schema.unitTypes.id });
  await audit(db, input.actor, property.id, "unit_type", created.id, "settings.unit_type_created", {}, { name, slug, bedrooms: input.bedrooms, maxGuests: input.maxGuests, baseRate: input.baseRate });
  return { ok: true, id: created.id };
}

export const UNIT_CODE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;

/** A new villa of a type. Codes are unique across all properties (they appear on bookings and invoices). */
export async function createUnit(db: AnyDb, input: { unitTypeId: string; code: string; name: string; actor: Actor }): Promise<SettingsResult> {
  const [type] = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.id, input.unitTypeId));
  if (!type) return { ok: false, error: "not_found" };
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 80) || `${type.name} ${code}`;
  if (!UNIT_CODE.test(code)) return { ok: false, error: "invalid" };
  const [exists] = await db.select({ id: schema.units.id }).from(schema.units).where(eq(schema.units.code, code));
  if (exists) return { ok: false, error: "code_taken" };
  const [created] = await db.insert(schema.units).values({ propertyId: type.propertyId, unitTypeId: type.id, code, name }).returning({ id: schema.units.id });
  await audit(db, input.actor, type.propertyId, "unit", created.id, "settings.unit_created", {}, { code, name, type: type.name });
  return { ok: true, id: created.id };
}

/** Takes a villa out of use (or back). A villa with a current or coming booking cannot be taken out. */
export async function setUnitActive(db: AnyDb, input: { unitId: string; active: boolean; today: string; actor: Actor }): Promise<SettingsResult> {
  const [unit] = await db.select().from(schema.units).where(eq(schema.units.id, input.unitId));
  if (!unit) return { ok: false, error: "not_found" };
  if (unit.isActive === input.active) return { ok: true };
  if (!input.active) {
    const [booked] = await db
      .select({ id: schema.reservations.id })
      .from(schema.reservations)
      .where(and(eq(schema.reservations.unitId, unit.id), inArray(schema.reservations.status, ["hold", "confirmed", "in_house"]), gt(schema.reservations.checkOut, input.today)))
      .limit(1);
    if (booked) return { ok: false, error: "has_bookings" };
  }
  await db.update(schema.units).set({ isActive: input.active, updatedAt: new Date() }).where(eq(schema.units.id, unit.id));
  await audit(db, input.actor, unit.propertyId, "unit", unit.id, input.active ? "settings.unit_activated" : "settings.unit_deactivated", { isActive: unit.isActive }, { isActive: input.active });
  return { ok: true };
}

/**
 * Reads a map point from what staff paste: "-8.5069, 115.2625", or a Google
 * Maps link (…/@-8.5069,115.2625,17z, …?q=-8.5069,115.2625, …!3d-8.5069!4d115.2625).
 * Short links (maps.app.goo.gl) carry no coordinates and return null.
 */
export function parseCoordinates(input: string): { lat: number; lng: number } | null {
  const s = decodeURIComponent(input.trim());
  const num = String.raw`(-?\d{1,3}(?:\.\d+)?)`;
  const patterns = [
    new RegExp(String.raw`!3d${num}!4d${num}`),
    new RegExp(String.raw`@${num},\s*${num}`),
    new RegExp(String.raw`[?&](?:q|query|ll|center|destination)=${num},\s*${num}`),
    new RegExp(String.raw`^${num}\s*,\s*${num}$`),
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
  }
  return null;
}

const PHONE = /^\+?[0-9 ()-]{6,20}$/;

/** Name, area line, address, contact, directions and map point: what guests need to find the property. */
export async function updatePropertyProfile(
  db: AnyDb,
  input: {
    propertyId: string;
    name: string;
    location?: LocalizedText;
    address?: string;
    phone?: string;
    whatsapp?: string;
    email?: string;
    directions?: LocalizedText;
    /** Pasted coordinates or a map link; empty removes the point. */
    map?: string;
    actor: Actor;
  },
): Promise<SettingsResult | { ok: false; error: "map" }> {
  const [property] = await db.select().from(schema.properties).where(eq(schema.properties.id, input.propertyId));
  if (!property) return { ok: false, error: "not_found" };
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) return { ok: false, error: "invalid" };
  const phone = clean(input.phone, 20);
  const whatsapp = clean(input.whatsapp, 20);
  const email = clean(input.email, 200);
  if ((phone && !PHONE.test(phone)) || (whatsapp && !PHONE.test(whatsapp)) || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { ok: false, error: "invalid" };
  const mapText = clean(input.map, 2000);
  const geo = mapText ? parseCoordinates(mapText) : null;
  if (mapText && !geo) return { ok: false, error: "map" };
  const contact = { phone: phone || undefined, whatsapp: whatsapp || undefined, email: email || undefined };
  const content: PropertyContent = {
    ...property.content,
    location: text(input.location, 300),
    address: clean(input.address, 400) || undefined,
    contact: Object.values(contact).some(Boolean) ? contact : undefined,
    directions: text(input.directions, 2000),
    geo: geo ?? undefined,
  };
  await db.update(schema.properties).set({ name, content, updatedAt: new Date() }).where(eq(schema.properties.id, property.id));
  await audit(db, input.actor, property.id, "property", property.id, "settings.profile_updated", { name: property.name, content: property.content }, { name, content });
  return { ok: true };
}

export const TIMEZONES = ["Asia/Makassar", "Asia/Jakarta", "Asia/Jayapura"] as const;

/** A new property; its villa types, rates and staff are set up afterwards. Unique slug from the name. */
export async function createProperty(db: AnyDb, input: { name: string; timezone: string; actor: Actor }): Promise<SettingsResult> {
  const name = input.name.trim().replace(/\s+/g, " ");
  const base = slugify(name);
  if (name.length < 2 || name.length > 80 || !base || !(TIMEZONES as readonly string[]).includes(input.timezone)) return { ok: false, error: "invalid" };
  const taken = new Set((await db.select({ slug: schema.properties.slug }).from(schema.properties)).map((p) => p.slug));
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  const [created] = await db.insert(schema.properties).values({ slug, name, timezone: input.timezone }).returning({ id: schema.properties.id });
  await audit(db, input.actor, created.id, "property", created.id, "settings.property_created", {}, { name, slug, timezone: input.timezone });
  return { ok: true, id: created.id };
}

/**
 * Deletes a property for good (decided with the owner, 26 Nov 2026): only a
 * closed one, only when its name is typed to confirm, and only when it never
 * had a booking or owner records, so no money history is lost. Its villa
 * types, villas, rates, closures, promo codes, add-ons, tasks, report
 * schedules and staff assignments go with it. The audit log keeps its
 * entries (without the property link) plus one for the deletion.
 */
export async function deleteProperty(db: AnyDb, input: { propertyId: string; confirmName: string; actor: Actor }): Promise<SettingsResult> {
  const [property] = await db.select().from(schema.properties).where(eq(schema.properties.id, input.propertyId));
  if (!property) return { ok: false, error: "not_found" };
  if (property.isActive) return { ok: false, error: "still_active" };
  const typed = input.confirmName.trim().replace(/\s+/g, " ").toLowerCase();
  if (typed !== property.name.trim().replace(/\s+/g, " ").toLowerCase()) return { ok: false, error: "confirm_name" };
  const id = property.id;
  const [booked] = await db.select({ id: schema.reservations.id }).from(schema.reservations).where(eq(schema.reservations.propertyId, id)).limit(1);
  if (booked) return { ok: false, error: "ever_booked" };
  const unitIds = db.select({ id: schema.units.id }).from(schema.units).where(eq(schema.units.propertyId, id));
  const [owned] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sql`(
      SELECT 1 FROM ${schema.unitOwnerships} WHERE ${schema.unitOwnerships.unitId} IN ${unitIds}
      UNION ALL SELECT 1 FROM ${schema.ownerExpenses} WHERE ${schema.ownerExpenses.propertyId} = ${id}
      UNION ALL SELECT 1 FROM ${schema.recurringExpenses} WHERE ${schema.recurringExpenses.propertyId} = ${id}
      UNION ALL SELECT 1 FROM ${schema.ownerStatements} WHERE ${schema.ownerStatements.propertyId} = ${id}
    ) AS owner_records`);
  if (owned.n > 0) return { ok: false, error: "has_owner_records" };

  await db.transaction(async (tx) => {
    // Rows that point at the property (or its villa types) without cascading.
    await tx.delete(schema.reportRuns).where(eq(schema.reportRuns.propertyId, id));
    await tx.delete(schema.reportSubscriptions).where(eq(schema.reportSubscriptions.propertyId, id));
    await tx.delete(schema.addons).where(eq(schema.addons.propertyId, id));
    await tx.delete(schema.promoCodes).where(eq(schema.promoCodes.propertyId, id));
    await tx.delete(schema.arrivalClosures).where(eq(schema.arrivalClosures.propertyId, id));
    // Villas take their status, blocks, calendar feeds and tasks with them; villa types their seasons.
    await tx.delete(schema.units).where(eq(schema.units.propertyId, id));
    await tx.delete(schema.unitTypes).where(eq(schema.unitTypes.propertyId, id));
    await tx.update(schema.auditEvents).set({ propertyId: null }).where(eq(schema.auditEvents.propertyId, id));
    // Staff assignments, invoice counters and remaining tasks cascade.
    await tx.delete(schema.properties).where(eq(schema.properties.id, id));
    await tx.insert(schema.auditEvents).values({
      actorType: "staff",
      actorId: input.actor.id,
      propertyId: null,
      entityType: "property",
      entityId: id,
      action: "settings.property_deleted",
      before: { name: property.name, slug: property.slug, timezone: property.timezone },
      after: {},
      occurredAt: new Date(),
    });
  });
  return { ok: true };
}

/** Closes a property to new bookings and the website (or opens it again). Not while bookings are current or coming. */
export async function setPropertyActive(db: AnyDb, input: { propertyId: string; active: boolean; today: string; actor: Actor }): Promise<SettingsResult> {
  const [property] = await db.select().from(schema.properties).where(eq(schema.properties.id, input.propertyId));
  if (!property) return { ok: false, error: "not_found" };
  if (property.isActive === input.active) return { ok: true };
  if (!input.active) {
    const [booked] = await db
      .select({ id: schema.reservations.id })
      .from(schema.reservations)
      .where(and(eq(schema.reservations.propertyId, property.id), inArray(schema.reservations.status, ["hold", "confirmed", "in_house"]), gt(schema.reservations.checkOut, input.today)))
      .limit(1);
    if (booked) return { ok: false, error: "has_bookings" };
  }
  await db.update(schema.properties).set({ isActive: input.active, updatedAt: new Date() }).where(eq(schema.properties.id, property.id));
  await audit(db, input.actor, property.id, "property", property.id, input.active ? "settings.property_activated" : "settings.property_deactivated", { isActive: property.isActive }, { isActive: input.active });
  return { ok: true };
}
