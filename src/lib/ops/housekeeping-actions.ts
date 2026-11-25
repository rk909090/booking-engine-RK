"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { changeUnitState, createBlock, resolveBlock, type HkResult, type HkState } from "@/domain/housekeeping";
import { hasLocale, type Locale } from "@/i18n/config";
import { requireStaff } from "@/lib/auth/current-staff";
import { can, type Action } from "@/lib/authz/permissions";

/*
 * Housekeeping and maintenance actions from the Villa status page. Each one
 * re-checks the session, role and property scope on the server, then sends
 * the user back with a short outcome code (no personal data in the URL).
 */

function field(form: FormData, key: string) {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

async function run(form: FormData, action: Action, unitId: string, op: (staffId: string) => Promise<HkResult>) {
  const raw = field(form, "lang");
  const lang: Locale = hasLocale(raw) ? raw : "id";
  const property = field(form, "property");
  const back: (query: string) => never = (query) =>
    redirect(`/${lang}/ops/villa-status?property=${encodeURIComponent(property)}&${query}#unit-${unitId}`);

  const staff = await requireStaff(lang);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(unitId)) back("error=not_found");
  const [unit] = await getDb()
    .select({ propertyId: schema.units.propertyId })
    .from(schema.units)
    .where(eq(schema.units.id, unitId))
    .limit(1);
  if (!unit) back("error=not_found");
  const decision = can(staff.actor, action, unit.propertyId);
  if (!decision.allowed) back(decision.reason === "outside_property_scope" ? "error=not_found" : "error=role");

  const result = await op(staff.staffId);
  back(result.ok ? "done=1" : `error=${result.error}${result.codes?.length ? `&codes=${result.codes.join(",")}` : ""}`);
}

const STATES = schema.housekeepingState.enumValues;

export async function changeUnitStateAction(form: FormData) {
  const unitId = field(form, "unitId");
  const to = STATES.find((s) => s === field(form, "to")) as HkState | undefined;
  await run(form, "housekeeping.update", unitId, (staffId) =>
    to
      ? changeUnitState(getDb(), { unitId, to, note: field(form, "note") || null, actor: { type: "staff", id: staffId } })
      : Promise.resolve({ ok: false, error: "invalid_transition" }),
  );
}

export async function createBlockAction(form: FormData) {
  const unitId = field(form, "unitId");
  await run(form, "unit.block", unitId, (staffId) =>
    createBlock(getDb(), {
      unitId,
      startDate: field(form, "startDate"),
      endDate: field(form, "endDate"),
      reason: field(form, "reason"),
      actor: { type: "staff", id: staffId },
    }),
  );
}

export async function resolveBlockAction(form: FormData) {
  const blockId = field(form, "blockId");
  // Authorise against the block's own unit, never a unit id sent by the form.
  const [block] = /^[0-9a-f-]{36}$/i.test(blockId)
    ? await getDb().select({ unitId: schema.unitBlocks.unitId }).from(schema.unitBlocks).where(eq(schema.unitBlocks.id, blockId)).limit(1)
    : [];
  await run(form, "unit.block", block?.unitId ?? "00000000-0000-0000-0000-000000000000", (staffId) =>
    resolveBlock(getDb(), { blockId, actor: { type: "staff", id: staffId } }),
  );
}
