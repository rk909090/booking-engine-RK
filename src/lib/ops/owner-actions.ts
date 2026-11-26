"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { todayIn } from "@/domain/dates";
import {
  addExpense,
  addRecurring,
  assignUnit,
  COMMISSION_SOURCES,
  createOwner,
  endOwnership,
  lockStatement,
  markStatementPaid,
  setCommissionRates,
  stopRecurring,
  updateOwner,
  voidExpense,
  type OwnersResult,
} from "@/domain/owners";
import type { CommissionRates } from "@/domain/types";
import { hasLocale, type Locale } from "@/i18n/config";
import { requireStaff } from "@/lib/auth/current-staff";
import { can, type Action } from "@/lib/authz/permissions";

/*
 * Owner area actions. Each re-checks the session and the role for the
 * property it touches, then returns to the page with a short outcome code
 * (refreshing the router, since the URL is often unchanged).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function field(form: FormData, key: string) {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/** Whole rupiah from "1.500.000"; a leading minus is kept (adjustments). NaN when not a number. */
function money(form: FormData, key: string): number {
  const raw = field(form, key).replace(/[.,\s]/g, "");
  return /^-?\d+$/.test(raw) ? Number(raw) : NaN;
}

function percentBp(raw: string): number {
  const n = Number(raw.replace(",", "."));
  return raw && Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

type Page = "statements" | "setup" | "expenses";
const PATHS: Record<Page, string> = { statements: "owners", setup: "owners/setup", expenses: "owners/expenses" };

async function guarded(form: FormData, page: Page, action: Action, propertyIdOf: () => Promise<string | null>, op: (actor: { type: "staff"; id: string }, propertyId: string) => Promise<OwnersResult>) {
  const langRaw = field(form, "lang");
  const lang: Locale = hasLocale(langRaw) ? langRaw : "id";
  const property = field(form, "property");
  const month = field(form, "month");
  const anchor = field(form, "anchor");
  const back = (query: string): never => {
    const params = new URLSearchParams();
    if (property) params.set("property", property);
    if (MONTH.test(month)) params.set("month", month);
    refresh();
    redirect(`/${lang}/ops/${PATHS[page]}?${params.toString()}${params.size ? "&" : ""}${query}${/^[a-z0-9-]+$/i.test(anchor) ? `#${anchor}` : ""}`);
  };
  const staff = await requireStaff(lang);
  const propertyId = await propertyIdOf();
  if (!propertyId) back("error=not_found");
  if (!can(staff.actor, action, propertyId!).allowed) back("error=role");
  const result = await op({ type: "staff", id: staff.staffId }, propertyId!);
  back(result.ok ? "done=1" : `error=${result.error}`);
}

async function propertyById(id: string) {
  if (!UUID.test(id)) return null;
  const [row] = await getDb().select({ id: schema.properties.id }).from(schema.properties).where(eq(schema.properties.id, id));
  return row?.id ?? null;
}

async function propertyOfUnit(unitId: string) {
  if (!UUID.test(unitId)) return null;
  const [row] = await getDb().select({ propertyId: schema.units.propertyId }).from(schema.units).where(eq(schema.units.id, unitId));
  return row?.propertyId ?? null;
}

/* Owners are not tied to one property; managing them needs the manager role at the property the form came from. */
export async function createOwnerAction(form: FormData) {
  await guarded(form, "setup", "owners.manage", () => propertyById(field(form, "propertyId")), (actor) =>
    createOwner(getDb(), { fullName: field(form, "fullName"), email: field(form, "email") || null, phone: field(form, "phone") || null, note: field(form, "note") || null, actor }),
  );
}

export async function updateOwnerAction(form: FormData) {
  const ownerId = field(form, "ownerId");
  await guarded(form, "setup", "owners.manage", () => propertyById(field(form, "propertyId")), (actor) =>
    UUID.test(ownerId)
      ? updateOwner(getDb(), { ownerId, fullName: field(form, "fullName"), email: field(form, "email") || null, phone: field(form, "phone") || null, note: field(form, "note") || null, actor })
      : Promise.resolve({ ok: false, error: "not_found" }),
  );
}

export async function assignUnitAction(form: FormData) {
  const unitId = field(form, "unitId");
  const ownerId = field(form, "ownerId");
  await guarded(form, "setup", "owners.manage", () => propertyOfUnit(unitId), (actor) =>
    UUID.test(ownerId)
      ? assignUnit(getDb(), { unitId, ownerId, startDate: field(form, "startDate"), feeBp: percentBp(field(form, "feePercent")), actor })
      : Promise.resolve({ ok: false, error: "not_found" }),
  );
}

export async function endOwnershipAction(form: FormData) {
  const ownershipId = field(form, "ownershipId");
  await guarded(
    form,
    "setup",
    "owners.manage",
    async () => {
      if (!UUID.test(ownershipId)) return null;
      const [row] = await getDb()
        .select({ propertyId: schema.units.propertyId })
        .from(schema.unitOwnerships)
        .innerJoin(schema.units, eq(schema.units.id, schema.unitOwnerships.unitId))
        .where(eq(schema.unitOwnerships.id, ownershipId));
      return row?.propertyId ?? null;
    },
    (actor) => endOwnership(getDb(), { ownershipId, endDate: field(form, "endDate"), actor }),
  );
}

export async function setCommissionAction(form: FormData) {
  const rates: CommissionRates = {};
  for (const source of COMMISSION_SOURCES) {
    const raw = field(form, `rate_${source}`);
    if (raw) rates[source] = percentBp(raw);
  }
  await guarded(form, "setup", "owners.manage", () => propertyById(field(form, "propertyId")), (actor, propertyId) => setCommissionRates(getDb(), { propertyId, rates, actor }));
}

export async function addExpenseAction(form: FormData) {
  const unitId = field(form, "unitId");
  await guarded(form, "expenses", "owners.expense", () => propertyOfUnit(unitId), (actor) =>
    addExpense(getDb(), { unitId, date: field(form, "date"), category: field(form, "category"), description: field(form, "description"), amount: money(form, "amount"), actor }),
  );
}

export async function voidExpenseAction(form: FormData) {
  const expenseId = field(form, "expenseId");
  await guarded(
    form,
    "expenses",
    "owners.expense",
    async () => {
      if (!UUID.test(expenseId)) return null;
      const [row] = await getDb().select({ propertyId: schema.ownerExpenses.propertyId }).from(schema.ownerExpenses).where(eq(schema.ownerExpenses.id, expenseId));
      return row?.propertyId ?? null;
    },
    (actor) => voidExpense(getDb(), { expenseId, reason: field(form, "reason"), actor }),
  );
}

export async function addRecurringAction(form: FormData) {
  const unitId = field(form, "unitId");
  await guarded(form, "expenses", "owners.manage", () => propertyOfUnit(unitId), (actor) =>
    addRecurring(getDb(), { unitId, category: field(form, "category"), description: field(form, "description"), amount: money(form, "amount"), startMonth: field(form, "startMonth"), actor }),
  );
}

export async function stopRecurringAction(form: FormData) {
  const recurringId = field(form, "recurringId");
  await guarded(
    form,
    "expenses",
    "owners.manage",
    async () => {
      if (!UUID.test(recurringId)) return null;
      const [row] = await getDb().select({ propertyId: schema.recurringExpenses.propertyId }).from(schema.recurringExpenses).where(eq(schema.recurringExpenses.id, recurringId));
      return row?.propertyId ?? null;
    },
    (actor) => stopRecurring(getDb(), { recurringId, lastMonth: field(form, "lastMonth"), actor }),
  );
}

export async function lockStatementAction(form: FormData) {
  const ownerId = field(form, "ownerId");
  await guarded(form, "statements", "owners.manage", () => propertyById(field(form, "propertyId")), async (actor, propertyId) => {
    const [p] = await getDb().select({ timezone: schema.properties.timezone }).from(schema.properties).where(eq(schema.properties.id, propertyId));
    return UUID.test(ownerId)
      ? lockStatement(getDb(), { ownerId, propertyId, month: field(form, "month"), today: todayIn(p.timezone), actor })
      : { ok: false, error: "not_found" };
  });
}

export async function markPaidAction(form: FormData) {
  const statementId = field(form, "statementId");
  await guarded(
    form,
    "statements",
    "owners.manage",
    async () => {
      if (!UUID.test(statementId)) return null;
      const [row] = await getDb().select({ propertyId: schema.ownerStatements.propertyId }).from(schema.ownerStatements).where(eq(schema.ownerStatements.id, statementId));
      return row?.propertyId ?? null;
    },
    (actor) => markStatementPaid(getDb(), { statementId, reference: field(form, "reference"), actor }),
  );
}
