"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import {
  addArrivalClosure,
  addSeason,
  createPromo,
  removeArrivalClosure,
  removeSeason,
  setPromoActive,
  updateOffers,
  updateGuestTimes,
  updateTypeRates,
  type RatesResult,
} from "@/domain/rates";
import type { LongStayTier } from "@/domain/types";
import { createAddon, updateAddon } from "@/domain/addons";
import { hasLocale, type Locale } from "@/i18n/config";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";

/*
 * Rate settings actions (branch managers). Each re-checks the session and
 * the role for the property it touches, then returns to the page with a
 * short outcome code. The page URL is often the same as before, so the
 * router is refreshed too.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(form: FormData, key: string) {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/** Whole rupiah from "1.500.000" or "1500000"; null when empty, NaN when not a number. */
function money(form: FormData, key: string): number | null {
  const raw = field(form, key);
  if (!raw) return null;
  const digits = raw.replace(/[.,\s]/g, "");
  return /^\d+$/.test(digits) ? Number(digits) : NaN;
}

/** Basis points from "10" or "12,5" percent; null when empty, NaN when not a number. */
function percentBp(form: FormData, key: string): number | null {
  const raw = field(form, key).replace(",", ".");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function int(form: FormData, key: string): number | null {
  const raw = field(form, key);
  if (!raw) return null;
  return /^\d+$/.test(raw) ? Number(raw) : NaN;
}

const date = (form: FormData, key: string) => field(form, key) || null;

type Ctx = { lang: Locale; actor: { type: "staff"; id: string } };

async function guarded(form: FormData, page: "rates" | "promos" | "addons", propertyIdOf: () => Promise<string | null>, op: (ctx: Ctx) => Promise<RatesResult>) {
  const langRaw = field(form, "lang");
  const lang: Locale = hasLocale(langRaw) ? langRaw : "id";
  const property = field(form, "property");
  const anchor = field(form, "anchor");
  const path = page === "rates" ? "rates" : `rates/${page}`;
  const back = (query: string): never => {
    refresh();
    redirect(`/${lang}/ops/${path}?${property ? `property=${encodeURIComponent(property)}&` : ""}${query}${/^[a-z0-9-]+$/i.test(anchor) ? `#${anchor}` : ""}`);
  };
  const staff = await requireStaff(lang);
  const propertyId = await propertyIdOf();
  if (!propertyId) back("error=not_found");
  if (!can(staff.actor, "rates.manage", propertyId!).allowed) back("error=role");
  const result = await op({ lang, actor: { type: "staff", id: staff.staffId } });
  back(result.ok ? "done=1" : `error=${result.error}`);
}

async function propertyOfType(unitTypeId: string) {
  if (!UUID.test(unitTypeId)) return null;
  const [row] = await getDb().select({ propertyId: schema.unitTypes.propertyId }).from(schema.unitTypes).where(eq(schema.unitTypes.id, unitTypeId));
  return row?.propertyId ?? null;
}

async function propertyById(propertyId: string) {
  if (!UUID.test(propertyId)) return null;
  const [row] = await getDb().select({ id: schema.properties.id }).from(schema.properties).where(eq(schema.properties.id, propertyId));
  return row?.id ?? null;
}

export async function updateTypeRatesAction(form: FormData) {
  const unitTypeId = field(form, "unitTypeId");
  await guarded(form, "rates", () => propertyOfType(unitTypeId), ({ actor }) =>
    updateTypeRates(getDb(), {
      unitTypeId,
      baseRate: money(form, "baseRate") ?? NaN,
      weekendRate: money(form, "weekendRate"),
      minStayNights: int(form, "minStay") ?? NaN,
      maxStayNights: int(form, "maxStay") ?? NaN,
      actor,
    }),
  );
}

export async function addSeasonAction(form: FormData) {
  const unitTypeId = field(form, "unitTypeId");
  await guarded(form, "rates", () => propertyOfType(unitTypeId), ({ actor }) =>
    addSeason(getDb(), {
      unitTypeId,
      name: field(form, "name"),
      startDate: field(form, "startDate"),
      endDate: field(form, "endDate"),
      nightlyRate: money(form, "nightlyRate") ?? NaN,
      weekendRate: money(form, "weekendRate"),
      minStayNights: int(form, "minStay"),
      actor,
    }),
  );
}

export async function removeSeasonAction(form: FormData) {
  const seasonId = field(form, "seasonId");
  await guarded(
    form,
    "rates",
    async () => {
      if (!UUID.test(seasonId)) return null;
      const [row] = await getDb()
        .select({ propertyId: schema.unitTypes.propertyId })
        .from(schema.rateSeasons)
        .innerJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.rateSeasons.unitTypeId))
        .where(eq(schema.rateSeasons.id, seasonId));
      return row?.propertyId ?? null;
    },
    ({ actor }) => removeSeason(getDb(), { seasonId, actor }),
  );
}

export async function addClosureAction(form: FormData) {
  const propertyId = field(form, "propertyId");
  const unitTypeId = field(form, "unitTypeId");
  await guarded(form, "rates", () => propertyById(propertyId), ({ actor }) =>
    addArrivalClosure(getDb(), {
      propertyId,
      unitTypeId: UUID.test(unitTypeId) ? unitTypeId : null,
      startDate: field(form, "startDate"),
      endDate: field(form, "endDate"),
      note: field(form, "note") || null,
      actor,
    }),
  );
}

export async function removeClosureAction(form: FormData) {
  const closureId = field(form, "closureId");
  await guarded(
    form,
    "rates",
    async () => {
      if (!UUID.test(closureId)) return null;
      const [row] = await getDb().select({ propertyId: schema.arrivalClosures.propertyId }).from(schema.arrivalClosures).where(eq(schema.arrivalClosures.id, closureId));
      return row?.propertyId ?? null;
    },
    ({ actor }) => removeArrivalClosure(getDb(), { closureId, actor }),
  );
}

export async function updateOffersAction(form: FormData) {
  const propertyId = field(form, "propertyId");
  const tiers: LongStayTier[] = [];
  for (const i of [1, 2, 3]) {
    const nights = int(form, `tierNights${i}`);
    const bp = percentBp(form, `tierPercent${i}`);
    if (nights === null && bp === null) continue;
    tiers.push({ minNights: nights ?? NaN, bp: bp ?? NaN });
  }
  await guarded(form, "rates", () => propertyById(propertyId), ({ actor }) =>
    updateOffers(getDb(), {
      propertyId,
      nonRefundableBp: form.get("nonRefundableOn") === "on" ? (percentBp(form, "nonRefundablePercent") ?? NaN) : null,
      breakfastPerGuest: form.get("breakfastOn") === "on" ? (money(form, "breakfastPrice") ?? NaN) : null,
      earlyBirdDays: form.get("earlyBirdOn") === "on" ? (int(form, "earlyBirdDays") ?? NaN) : null,
      earlyBirdBp: form.get("earlyBirdOn") === "on" ? (percentBp(form, "earlyBirdPercent") ?? NaN) : null,
      longStayTiers: tiers,
      actor,
    }),
  );
}

export async function createPromoAction(form: FormData) {
  const propertyId = field(form, "propertyId");
  const kind = field(form, "kind") === "amount" ? "amount" : "percent";
  await guarded(form, "promos", () => propertyById(propertyId), ({ actor }) =>
    createPromo(getDb(), {
      propertyId,
      code: field(form, "code"),
      kind,
      valueBp: kind === "percent" ? (percentBp(form, "value") ?? NaN) : null,
      amount: kind === "amount" ? (money(form, "value") ?? NaN) : null,
      bookFrom: date(form, "bookFrom"),
      bookUntil: date(form, "bookUntil"),
      stayFrom: date(form, "stayFrom"),
      stayUntil: date(form, "stayUntil"),
      minNights: int(form, "minNights"),
      unitTypeIds: form.getAll("unitTypeIds").filter((v): v is string => typeof v === "string" && UUID.test(v)),
      maxUses: int(form, "maxUses"),
      note: field(form, "note") || null,
      actor,
    }),
  );
}

export async function setPromoActiveAction(form: FormData) {
  const promoId = field(form, "promoId");
  await guarded(
    form,
    "promos",
    async () => {
      if (!UUID.test(promoId)) return null;
      const [row] = await getDb().select({ propertyId: schema.promoCodes.propertyId }).from(schema.promoCodes).where(eq(schema.promoCodes.id, promoId));
      return row?.propertyId ?? null;
    },
    ({ actor }) => setPromoActive(getDb(), { promoId, active: field(form, "active") === "1", actor }),
  );
}

function addonFields(form: FormData) {
  return {
    name: { id: field(form, "nameId"), en: field(form, "nameEn") },
    description: { id: field(form, "descId"), en: field(form, "descEn") },
    category: field(form, "category"),
    pricing: field(form, "pricing"),
    price: money(form, "price") ?? NaN,
    needsTime: form.get("needsTime") === "on",
    leadHours: int(form, "leadHours") ?? 24,
    sortOrder: int(form, "sortOrder") ?? 0,
  };
}

/** Adds an add-on or experience to the property's catalog. */
export async function createAddonAction(form: FormData) {
  const propertyId = field(form, "propertyId");
  await guarded(form, "addons", () => propertyById(propertyId), async ({ actor }) => {
    const r = await createAddon(getDb(), { propertyId, ...addonFields(form), actor });
    return r.ok ? { ok: true } : { ok: false, error: "invalid" };
  });
}

/** Changes an add-on (orders already placed keep their price), or switches it off. */
export async function updateAddonAction(form: FormData) {
  const propertyId = field(form, "propertyId");
  const addonId = field(form, "addonId");
  await guarded(form, "addons", () => propertyById(propertyId), async ({ actor }) => {
    if (!UUID.test(addonId)) return { ok: false, error: "not_found" };
    const r = await updateAddon(getDb(), { propertyId, addonId, isActive: form.get("isActive") === "on", ...addonFields(form), actor });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });
}

/** Latest late check-out and earliest early check-in guests may ask for from their booking page. */
export async function updateGuestTimesAction(form: FormData) {
  const propertyId = field(form, "propertyId");
  await guarded(form, "rates", () => propertyById(propertyId), ({ actor }) =>
    updateGuestTimes(getDb(), { propertyId, lateLatest: field(form, "lateLatest"), earlyEarliest: field(form, "earlyEarliest"), actor }),
  );
}
