"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { todayIn } from "@/domain/dates";
import { createProperty, createUnit, deleteProperty, createUnitType, setPropertyActive, setUnitActive, updatePropertyContent, updatePropertyPolicies, updatePropertyProfile, updateUnitTypeDetails } from "@/domain/settings";
import { hasLocale, locales, type Locale } from "@/i18n/config";
import { getDictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";

/*
 * Settings pages. Each action re-checks the session and that the staff member
 * may change this property's settings, then returns to the same section with
 * ?done=1 or ?error=<code>.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(form: FormData, key: string) {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/** "10", "10,5" or "10.5" percent as basis points; NaN when not a number. */
function bp(raw: string): number {
  if (!/^\d{1,3}([.,]\d{1,2})?$/.test(raw)) return NaN;
  return Math.round(Number(raw.replace(",", ".")) * 100);
}

function int(raw: string): number {
  return /^\d{1,7}$/.test(raw) ? Number(raw) : NaN;
}

/** Rupiah typed with or without thousands separators. */
function rupiah(raw: string): number {
  const digits = raw.replace(/[.,\s]/g, "");
  return /^\d{1,13}$/.test(digits) ? Number(digits) : NaN;
}

async function context(form: FormData, page: string) {
  const langRaw = field(form, "lang");
  const lang: Locale = hasLocale(langRaw) ? langRaw : "id";
  const propertyId = field(form, "propertyId");
  const slug = field(form, "property");
  const anchor = field(form, "anchor").replace(/[^a-z0-9-]/gi, "");
  const back = (query: string): never => {
    refresh();
    redirect(`/${lang}/ops/settings${page}?property=${encodeURIComponent(slug)}&${query}${anchor ? `#${anchor}` : ""}`);
  };
  const staff = await requireStaff(lang);
  if (!UUID.test(propertyId)) return back("error=not_found");
  const decision = can(staff.actor, "settings.manage", propertyId);
  if (!decision.allowed) return back(decision.reason === "outside_property_scope" ? "error=not_found" : "error=role");
  return { lang, propertyId, back, actor: { type: "staff" as const, id: staff.staffId } };
}

export async function saveProfileAction(form: FormData) {
  const { propertyId, back, actor } = await context(form, "");
  const result = await updatePropertyProfile(getDb(), {
    propertyId,
    name: field(form, "name"),
    location: pair(form, "location"),
    address: field(form, "address"),
    phone: field(form, "phone"),
    whatsapp: field(form, "whatsapp"),
    email: field(form, "email"),
    directions: pair(form, "directions"),
    map: field(form, "map"),
    actor,
  });
  back(result.ok ? "done=1" : `error=${result.error}`);
}

export async function savePoliciesAction(form: FormData) {
  const { propertyId, back, actor } = await context(form, "/policies");
  const days = form.getAll("tierDays").map((v) => (typeof v === "string" ? v.trim() : ""));
  const charges = form.getAll("tierCharge").map((v) => (typeof v === "string" ? v.trim() : ""));
  const tiers = days
    .map((d, i) => ({ d, c: charges[i] ?? "" }))
    .filter((r) => r.d !== "" || r.c !== "")
    .map((r) => ({ minDaysBefore: int(r.d), chargeBp: bp(r.c) }));
  const result = await updatePropertyPolicies(getDb(), {
    propertyId,
    checkInTime: field(form, "checkInTime"),
    checkOutTime: field(form, "checkOutTime"),
    taxRateBp: bp(field(form, "taxRate")),
    serviceRateBp: bp(field(form, "serviceRate")),
    depositRateBp: bp(field(form, "depositRate")),
    balanceDueDays: int(field(form, "balanceDueDays")),
    holdMinutes: int(field(form, "holdMinutes")),
    turnoverMinutes: int(field(form, "turnoverMinutes")),
    discountLimitFrontOfficeBp: bp(field(form, "discountFrontOffice")),
    discountLimitManagerBp: bp(field(form, "discountManager")),
    guestLateCheckoutLatest: field(form, "lateLatest"),
    guestEarlyCheckinEarliest: field(form, "earlyEarliest"),
    cancellationTiers: tiers,
    actor,
  });
  back(result.ok ? "done=1" : `error=${result.error}`);
}

const pair = (form: FormData, key: string) => ({ id: field(form, `${key}_id`), en: field(form, `${key}_en`) });
const ruleLines = (raw: string) => raw.split(/\r?\n/);

export async function saveContentAction(form: FormData) {
  const { propertyId, back, actor } = await context(form, "/content");
  const result = await updatePropertyContent(getDb(), {
    propertyId,
    tagline: pair(form, "tagline"),
    description: pair(form, "description"),
    houseRules: { id: ruleLines(field(form, "rules_id")), en: ruleLines(field(form, "rules_en")) },
    invoice: { legalName: field(form, "legalName"), address: field(form, "address"), taxId: field(form, "taxId"), phone: field(form, "phone"), email: field(form, "email") },
    actor,
  });
  back(result.ok ? "done=1" : `error=${result.error}`);
}

/** The type must belong to the property the staff member was checked for. */
async function typeOfProperty(unitTypeId: string, propertyId: string) {
  if (!UUID.test(unitTypeId)) return null;
  const [type] = await getDb().select({ id: schema.unitTypes.id, propertyId: schema.unitTypes.propertyId }).from(schema.unitTypes).where(eq(schema.unitTypes.id, unitTypeId));
  return type && type.propertyId === propertyId ? type : null;
}

export async function saveUnitTypeAction(form: FormData) {
  const { propertyId, back, actor } = await context(form, "/villas");
  const type = await typeOfProperty(field(form, "unitTypeId"), propertyId);
  if (!type) return back("error=not_found");
  // The form shows the general checklist when a type has none; saving it unchanged keeps the general one
  // (in each staff member's language) rather than storing one language's copy.
  const checklist = field(form, "checklist").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const defaults = await Promise.all(locales.map(async (l) => Object.values((await getDictionary(l)).tasks.defaultChecklist)));
  const isDefault = defaults.some((d) => d.length === checklist.length && d.every((item, i) => item === checklist[i]));
  const result = await updateUnitTypeDetails(getDb(), {
    unitTypeId: type.id,
    name: field(form, "name"),
    bedrooms: int(field(form, "bedrooms")),
    maxGuests: int(field(form, "maxGuests")),
    summary: pair(form, "summary"),
    description: pair(form, "description"),
    isPublished: field(form, "isPublished") === "on",
    checklist: isDefault ? [] : checklist,
    actor,
  });
  back(result.ok ? "done=1" : `error=${result.error}`);
}

export async function createUnitTypeAction(form: FormData) {
  const { propertyId, back, actor } = await context(form, "/villas");
  const result = await createUnitType(getDb(), {
    propertyId,
    name: field(form, "name"),
    bedrooms: int(field(form, "bedrooms")),
    maxGuests: int(field(form, "maxGuests")),
    baseRate: rupiah(field(form, "baseRate")),
    actor,
  });
  back(result.ok ? "done=created" : `error=${result.error}`);
}

export async function createUnitAction(form: FormData) {
  const { propertyId, back, actor } = await context(form, "/villas");
  const type = await typeOfProperty(field(form, "unitTypeId"), propertyId);
  if (!type) return back("error=not_found");
  const result = await createUnit(getDb(), { unitTypeId: type.id, code: field(form, "code"), name: field(form, "name"), actor });
  back(result.ok ? "done=1" : `error=${result.error}`);
}

export async function setUnitActiveAction(form: FormData) {
  const { propertyId, back, actor } = await context(form, "/villas");
  const unitId = field(form, "unitId");
  if (!UUID.test(unitId)) return back("error=not_found");
  const [unit] = await getDb()
    .select({ propertyId: schema.units.propertyId, timezone: schema.properties.timezone })
    .from(schema.units)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.units.propertyId))
    .where(eq(schema.units.id, unitId));
  if (!unit || unit.propertyId !== propertyId) return back("error=not_found");
  const result = await setUnitActive(getDb(), { unitId, active: field(form, "active") === "true", today: todayIn(unit.timezone), actor });
  back(result.ok ? "done=1" : `error=${result.error}`);
}

/** Directors (properties.manage) add properties; not tied to an existing one. */
export async function createPropertyAction(form: FormData) {
  const langRaw = field(form, "lang");
  const lang: Locale = hasLocale(langRaw) ? langRaw : "id";
  const staff = await requireStaff(lang);
  const back = (query: string): never => {
    refresh();
    redirect(`/${lang}/ops/settings/properties?${query}`);
  };
  if (!can(staff.actor, "properties.manage").allowed) return back("error=role");
  const result = await createProperty(getDb(), { name: field(form, "name"), timezone: field(form, "timezone"), actor: { type: "staff", id: staff.staffId } });
  if (!result.ok) return back(`error=${result.error}`);
  const [created] = await getDb().select({ slug: schema.properties.slug }).from(schema.properties).where(eq(schema.properties.id, result.id!));
  refresh();
  // Straight to the new property's profile, the next thing to fill in.
  redirect(`/${lang}/ops/settings?property=${created.slug}&done=property`);
}

export async function setPropertyActiveAction(form: FormData) {
  const langRaw = field(form, "lang");
  const lang: Locale = hasLocale(langRaw) ? langRaw : "id";
  const staff = await requireStaff(lang);
  const back = (query: string): never => {
    refresh();
    redirect(`/${lang}/ops/settings/properties?${query}`);
  };
  const propertyId = field(form, "propertyId");
  if (!UUID.test(propertyId)) return back("error=not_found");
  if (!can(staff.actor, "properties.manage").allowed) return back("error=role");
  const active = field(form, "active") === "true";
  if (!active && field(form, "confirm") !== "yes") return back("error=confirm");
  const [p] = await getDb().select({ timezone: schema.properties.timezone }).from(schema.properties).where(eq(schema.properties.id, propertyId));
  if (!p) return back("error=not_found");
  const result = await setPropertyActive(getDb(), { propertyId, active, today: todayIn(p.timezone), actor: { type: "staff", id: staff.staffId } });
  back(result.ok ? "done=1" : `error=${result.error}`);
}

/** Deletes a closed property that never had a booking (directors only; see domain/settings.ts). */
export async function deletePropertyAction(form: FormData) {
  const langRaw = field(form, "lang");
  const lang: Locale = hasLocale(langRaw) ? langRaw : "id";
  const staff = await requireStaff(lang);
  const back = (query: string): never => {
    refresh();
    redirect(`/${lang}/ops/settings/properties?${query}`);
  };
  const propertyId = field(form, "propertyId");
  if (!UUID.test(propertyId)) return back("error=not_found");
  if (!can(staff.actor, "properties.delete").allowed) return back("error=role");
  const result = await deleteProperty(getDb(), { propertyId, confirmName: field(form, "confirmName"), actor: { type: "staff", id: staff.staffId } });
  back(result.ok ? "done=deleted" : `error=${result.error}`);
}
