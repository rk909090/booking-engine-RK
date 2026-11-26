"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import {
  assignTask,
  cancelTask,
  claimTask,
  finishCleaning,
  finishInspection,
  finishTask,
  reportMaintenance,
  setInspectionChecklist,
  startTask,
} from "@/domain/tasks";
import { hasLocale, type Locale } from "@/i18n/config";
import { getDictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can, type Action } from "@/lib/authz/permissions";

/*
 * Task board actions. Each re-checks the session, the role and the task's
 * property, then returns to the board with a short outcome code. The board
 * URL is often the same as before (only the anchor differs), so each return
 * also refreshes the router, or the old board would be shown again.
 */

function backTo(url: string): never {
  refresh();
  redirect(url);
}

function field(form: FormData, key: string) {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function withTask(form: FormData, action: Action, op: (ctx: { taskId: string; actor: { type: "staff"; id: string }; lang: Locale; task: typeof schema.tasks.$inferSelect }) => Promise<{ ok: boolean; error?: string }>) {
  const langRaw = field(form, "lang");
  const lang: Locale = hasLocale(langRaw) ? langRaw : "id";
  const taskId = field(form, "taskId");
  // From a task's own page (or panel), return there; from the board, to the board.
  const back = (query: string): never =>
    backTo(field(form, "returnTo") === "detail" && UUID.test(taskId) ? `/${lang}/ops/tasks/${taskId}?${query}` : `/${lang}/ops/tasks?${query}${UUID.test(taskId) ? `#task-${taskId}` : ""}`);
  const staff = await requireStaff(lang);
  if (!UUID.test(taskId)) back("error=not_found");
  const [task] = await getDb().select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);
  if (!task) back("error=not_found");
  const decision = can(staff.actor, action, task.propertyId);
  if (!decision.allowed) back(decision.reason === "outside_property_scope" ? "error=not_found" : "error=role");
  const result = await op({ taskId, actor: { type: "staff", id: staff.staffId }, lang, task });
  back(result.ok ? "done=1" : `error=${result.error ?? "not_found"}`);
}

export async function claimTaskAction(form: FormData) {
  await withTask(form, "tasks.work", ({ taskId, actor }) => claimTask(getDb(), { taskId, actor }));
}

export async function startTaskAction(form: FormData) {
  await withTask(form, "tasks.work", ({ taskId, actor }) => startTask(getDb(), { taskId, actor }));
}

export async function assignTaskAction(form: FormData) {
  await withTask(form, "tasks.assign", ({ taskId, actor }) => {
    const assignee = field(form, "assigneeId");
    return assignTask(getDb(), { taskId, assigneeId: UUID.test(assignee) ? assignee : null, actor });
  });
}

export async function finishCleaningAction(form: FormData) {
  await withTask(form, "tasks.work", ({ taskId, actor }) => finishCleaning(getDb(), { taskId, actor, note: field(form, "note") || null }));
}

/** The checklist comes from the villa type, or the default list in the staff member's language. */
export async function finishInspectionAction(form: FormData) {
  await withTask(form, "tasks.work", async ({ taskId, actor, lang, task }) => {
    const [unit] = task.unitId
      ? await getDb()
          .select({ content: schema.unitTypes.content })
          .from(schema.units)
          .innerJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.units.unitTypeId))
          .where(eq(schema.units.id, task.unitId))
      : [];
    const checklist = unit?.content.inspectionChecklist?.length ? unit.content.inspectionChecklist : Object.values((await getDictionary(lang)).tasks.defaultChecklist);
    const ticked = form.getAll("ticked").filter((v): v is string => typeof v === "string");
    return finishInspection(getDb(), { taskId, checklist, ticked, passed: field(form, "result") === "passed", note: field(form, "note") || null, actor });
  });
}

/** A maintenance ticket's cost is charged to the villa's owner; only staff who may record owner expenses can give one. */
export async function finishTaskAction(form: FormData) {
  await withTask(form, "tasks.work", async ({ taskId, actor, task }) => {
    const costRaw = field(form, "cost").replace(/[.,\s]/g, "");
    let cost: number | null = null;
    if (costRaw) {
      const staff = await requireStaff(hasLocale(field(form, "lang")) ? (field(form, "lang") as Locale) : "id");
      if (!can(staff.actor, "owners.expense", task.propertyId).allowed) return { ok: false, error: "role" };
      cost = /^\d+$/.test(costRaw) ? Number(costRaw) : NaN;
    }
    return finishTask(getDb(), { taskId, actor, note: field(form, "note") || null, cost });
  });
}

export async function cancelTaskAction(form: FormData) {
  await withTask(form, "tasks.assign", ({ taskId, actor }) => cancelTask(getDb(), { taskId, actor }));
}

/** Reports something to fix in a villa, optionally taking it out of sale. */
export async function reportMaintenanceAction(form: FormData) {
  const langRaw = field(form, "lang");
  const lang: Locale = hasLocale(langRaw) ? langRaw : "id";
  const back = (query: string): never => backTo(`/${lang}/ops/tasks?${query}`);
  const staff = await requireStaff(lang);
  const unitId = field(form, "unitId");
  if (!UUID.test(unitId)) back("error=not_found");
  const [unit] = await getDb().select({ propertyId: schema.units.propertyId }).from(schema.units).where(eq(schema.units.id, unitId)).limit(1);
  if (!unit || !can(staff.actor, "tasks.work", unit.propertyId).allowed) back("error=role");
  const block = form.get("block") === "on";
  const result = await reportMaintenance(getDb(), {
    unitId,
    title: field(form, "title"),
    notes: field(form, "notes") || null,
    blockUntil: block ? field(form, "blockUntil") : null,
    actor: { type: "staff", id: staff.staffId },
  });
  if (!result.ok && result.codes?.length) back(`error=${result.error}&codes=${result.codes.slice(0, 5).join(",")}`);
  back(result.ok ? "done=reported" : `error=${result.error}`);
}

/** Saves a villa type's inspection checklist (branch managers). */
export async function saveChecklistAction(form: FormData) {
  const langRaw = field(form, "lang");
  const lang: Locale = hasLocale(langRaw) ? langRaw : "id";
  const back = (query: string): never => backTo(`/${lang}/ops/tasks?${query}#checklists`);
  const staff = await requireStaff(lang);
  const unitTypeId = field(form, "unitTypeId");
  if (!UUID.test(unitTypeId)) back("error=not_found");
  const [type] = await getDb().select({ propertyId: schema.unitTypes.propertyId }).from(schema.unitTypes).where(eq(schema.unitTypes.id, unitTypeId)).limit(1);
  if (!type || !can(staff.actor, "tasks.configure", type.propertyId).allowed) back("error=role");
  const result = await setInspectionChecklist(getDb(), { unitTypeId, items: field(form, "items").split("\n"), actor: { type: "staff", id: staff.staffId } });
  back(result.ok ? "done=checklist" : `error=${result.error}`);
}
