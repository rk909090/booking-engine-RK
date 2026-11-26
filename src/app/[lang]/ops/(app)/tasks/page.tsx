import { asc, inArray } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { NoAccess } from "@/components/ops/ops-shell";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { addDays, todayIn } from "@/domain/dates";
import { assignableStaff, taskBoard } from "@/domain/tasks";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { visibleProperties } from "@/lib/ops/queries";
import {
  reportMaintenanceAction,
  saveChecklistAction,
} from "@/lib/ops/task-actions";
import { TaskCard, type TaskRow } from "@/components/ops/task-card";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/tasks">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).tasks.title };
}

export default async function TasksPage({ params, searchParams }: PageProps<"/[lang]/ops/tasks">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
      <Board lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";
type Row = TaskRow;

async function Board({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "tasks.view").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const t = dict.tasks;
  const sp = await searchParams;
  const properties = (await visibleProperties(staff.actor)).filter((p) => can(staff.actor, "tasks.view", p.id).allowed);
  const propertyIds = properties.map((p) => p.id);
  const db = getDb();
  const [rows, units, types, staffByProperty] = await Promise.all([
    taskBoard(db, { propertyIds }),
    propertyIds.length
      ? db.select({ id: schema.units.id, code: schema.units.code, propertyId: schema.units.propertyId }).from(schema.units).where(inArray(schema.units.propertyId, propertyIds)).orderBy(asc(schema.units.code))
      : [],
    propertyIds.length
      ? db.select({ id: schema.unitTypes.id, name: schema.unitTypes.name, propertyId: schema.unitTypes.propertyId, content: schema.unitTypes.content }).from(schema.unitTypes).where(inArray(schema.unitTypes.propertyId, propertyIds)).orderBy(asc(schema.unitTypes.sortOrder))
      : [],
    Promise.all(propertyIds.map(async (id) => [id, await assignableStaff(db, id)] as const)).then((e) => new Map(e)),
  ]);
  const tz = properties[0]?.timezone ?? "Asia/Makassar";
  const now = new Date();
  const today = todayIn(tz, now);
  const nowTime = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const defaults = Object.values(t.defaultChecklist);
  const checklistOf = (r: Row) => (r.typeContent?.inspectionChecklist?.length ? r.typeContent.inspectionChecklist : defaults);
  const active = rows.filter((r) => r.task.status === "open" || r.task.status === "in_progress");
  const mine = active.filter((r) => r.task.assigneeId === staff.staffId);
  const unassigned = active.filter((r) => !r.task.assigneeId);
  const others = active.filter((r) => r.task.assigneeId && r.task.assigneeId !== staff.staffId);
  const done = rows.filter((r) => r.task.status === "done");
  const doneText = typeof sp.done === "string" ? ((t.done as Record<string, string>)[sp.done] ?? t.done["1"]) : null;
  const errorText = typeof sp.error === "string" ? ((t.errors as Record<string, string>)[sp.error] ?? t.errors.not_found) : null;
  const codes = typeof sp.codes === "string" ? sp.codes : "";

  const card = (r: Row) => (
    <TaskCard
      key={r.task.id}
      row={r}
      lang={lang}
      dict={dict}
      today={today}
      nowTime={nowTime}
      me={staff.staffId}
      canWork={can(staff.actor, "tasks.work", r.task.propertyId).allowed}
      canAssign={can(staff.actor, "tasks.assign", r.task.propertyId).allowed}
      canCost={can(staff.actor, "owners.expense", r.task.propertyId).allowed}
      people={staffByProperty.get(r.task.propertyId) ?? []}
      checklist={checklistOf(r)}
    />
  );

  return (
    <>
      <h1 className="font-display text-3xl text-lagoon">{t.title}</h1>
      <p className="mt-1 max-w-3xl text-sm text-stone">{t.intro}</p>
      <div className="mt-4 space-y-2">
        {doneText ? <SuccessNote>{doneText}</SuccessNote> : null}
        <ErrorNote>{errorText ? `${errorText}${codes ? ` (${codes})` : ""}` : null}</ErrorNote>
      </div>

      <Group title={format(t.mine, { count: mine.length })} empty={t.mineEmpty}>
        {mine.map(card)}
      </Group>
      <Group title={format(t.unassigned, { count: unassigned.length })} empty={t.unassignedEmpty}>
        {unassigned.map(card)}
      </Group>
      {others.length ? <Group title={format(t.others, { count: others.length })}>{others.map(card)}</Group> : null}

      {can(staff.actor, "tasks.work").allowed && units.length ? (
        <details className="mt-8 rounded-xl border border-line bg-white/70 p-4">
          <summary className="cursor-pointer font-display text-xl text-lagoon">{t.reportTitle}</summary>
          <form action={reportMaintenanceAction} className="mt-3 grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="lang" value={lang} />
            <label className="space-y-1 text-xs text-stone">
              <span className="block">{t.villa}</span>
              <select name="unitId" required className={input}>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.code}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs text-stone">
              <span className="block">{t.reportWhat}</span>
              <input name="title" required minLength={3} maxLength={160} placeholder={t.reportWhatHint} className={input} />
            </label>
            <label className="space-y-1 text-xs text-stone sm:col-span-2">
              <span className="block">{t.notes}</span>
              <textarea name="notes" rows={2} maxLength={1000} className={input} />
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" name="block" className="h-4 w-4 accent-lagoon" />
              {t.reportBlock}
            </label>
            <label className="space-y-1 text-xs text-stone">
              <span className="block">{t.reportBlockUntil}</span>
              <input type="date" name="blockUntil" min={addDays(today, 1)} defaultValue={addDays(today, 1)} className={input} />
            </label>
            <button type="submit" className="rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep sm:col-span-2">
              {t.reportSubmit}
            </button>
          </form>
        </details>
      ) : null}

      {done.length ? (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm text-lagoon">{format(t.doneRecently, { count: done.length })}</summary>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">{done.map(card)}</div>
        </details>
      ) : null}

      {types.some((ty) => can(staff.actor, "tasks.configure", ty.propertyId).allowed) ? (
        <details id="checklists" className="mt-6 rounded-xl border border-line bg-white/70 p-4">
          <summary className="cursor-pointer font-display text-xl text-lagoon">{t.checklistsTitle}</summary>
          <p className="mt-1 text-xs text-stone">{t.checklistsHint}</p>
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            {types
              .filter((ty) => can(staff.actor, "tasks.configure", ty.propertyId).allowed)
              .map((ty) => (
                <form key={ty.id} action={saveChecklistAction} className="space-y-2">
                  <input type="hidden" name="lang" value={lang} />
                  <input type="hidden" name="unitTypeId" value={ty.id} />
                  <label className="block space-y-1 text-xs text-stone">
                    <span className="block font-medium text-ink">{ty.name}</span>
                    <textarea name="items" rows={7} defaultValue={(ty.content.inspectionChecklist?.length ? ty.content.inspectionChecklist : defaults).join("\n")} className={input} />
                  </label>
                  <button type="submit" className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink hover:bg-sand">
                    {t.checklistSave}
                  </button>
                </form>
              ))}
          </div>
        </details>
      ) : null}
    </>
  );
}

function Group({ title, empty, children }: { title: string; empty?: string; children: ReactNode[] }) {
  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold uppercase tracking-[0.15em] text-terracotta-deep">{title}</h2>
      {children.length ? <div className="mt-3 grid gap-3 lg:grid-cols-2">{children}</div> : empty ? <p className="mt-2 text-sm text-stone">{empty}</p> : null}
    </section>
  );
}
