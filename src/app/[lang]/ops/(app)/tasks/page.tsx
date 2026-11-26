import { asc, inArray } from "drizzle-orm";
import { Wrench } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { FilterForm } from "@/components/ops/filter-form";
import { NoAccess } from "@/components/ops/ops-shell";
import { Card, filterClass, PageHeader, Pill, secondaryButton } from "@/components/ops/ui";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { addDays, todayIn } from "@/domain/dates";
import { assignableStaff, TASK_KINDS, urgency } from "@/domain/tasks";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { visibleProperties } from "@/lib/ops/queries";
import { assignTaskAction, claimTaskAction, reportMaintenanceAction, saveChecklistAction, startTaskAction } from "@/lib/ops/task-actions";
import { listTasks, taskCounts } from "@/lib/ops/task-list";

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
      <Tasks lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

async function Tasks({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "tasks.view").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const t = dict.tasks;
  const f = t.filters;
  const sp = await searchParams;
  const all = (await visibleProperties(staff.actor)).filter((p) => can(staff.actor, "tasks.view", p.id).allowed);
  const chosen = all.find((p) => p.slug === one(sp.property)) ?? null;
  const propertyIds = (chosen ? [chosen] : all).map((p) => p.id);
  const tz = all[0]?.timezone ?? "Asia/Makassar";
  const now = new Date();
  const today = todayIn(tz, now);
  const nowTime = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const db = getDb();
  const filters = { status: one(sp.status), kind: one(sp.kind), assignee: one(sp.assignee), due: one(sp.due), q: one(sp.q), page: Number(one(sp.page)) || 1 };
  const [list, counts, people, units, types] = await Promise.all([
    listTasks(staff.actor, { propertyIds, filters, today, nowTime }),
    taskCounts(staff.actor, { propertyIds, today, nowTime }),
    Promise.all(all.map(async (p) => [p.id, await assignableStaff(db, p.id)] as const)).then((e) => new Map(e)),
    all.length ? db.select({ id: schema.units.id, code: schema.units.code, propertyId: schema.units.propertyId }).from(schema.units).where(inArray(schema.units.propertyId, all.map((p) => p.id))).orderBy(asc(schema.units.code)) : [],
    all.length ? db.select({ id: schema.unitTypes.id, name: schema.unitTypes.name, propertyId: schema.unitTypes.propertyId, content: schema.unitTypes.content }).from(schema.unitTypes).where(inArray(schema.unitTypes.propertyId, all.map((p) => p.id))).orderBy(asc(schema.unitTypes.sortOrder)) : [],
  ]);
  const everyone = [...new Map([...people.values()].flat().map((p) => [p.id, p])).values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  const base = `/${lang}/ops/tasks`;
  const current = new URLSearchParams();
  for (const k of ["status", "kind", "assignee", "property", "due", "q", "page"]) if (one(sp[k])) current.set(k, one(sp[k]));
  const href = (over: Record<string, string | null>) => {
    const q = new URLSearchParams(current);
    q.delete("page");
    for (const [k, v] of Object.entries(over)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  };
  const doneText = one(sp.done) ? ((t.done as Record<string, string>)[one(sp.done)] ?? t.done["1"]) : null;
  const errorText = one(sp.error) ? ((t.errors as Record<string, string>)[one(sp.error)] ?? t.errors.not_found) : null;
  const when = new Intl.DateTimeFormat(lang === "id" ? "id-ID" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: tz });
  const kinds = t.kindLabels as Record<string, string>;
  const statusLabels = t.statusLabels as Record<string, string>;
  const titleOf = (task: (typeof list.rows)[number]["task"]) =>
    task.kind === "clean" ? t.kinds.clean : task.kind === "inspect" ? t.kinds.inspect : task.title.startsWith("Guest request") ? t.kinds.request : task.title;
  const quick: Array<{ key: string; label: string; count?: number; over: Record<string, string | null>; active: boolean; tone?: "bad" | "warn" }> = [
    { key: "active", label: t.quick.active, count: counts.active, over: { status: null, assignee: null, due: null }, active: list.applied.status === "active" && !filters.assignee && !filters.due },
    { key: "mine", label: t.quick.mine, count: counts.mine, over: { status: null, assignee: "me", due: null }, active: filters.assignee === "me" },
    { key: "unassigned", label: t.quick.unassigned, count: counts.unassigned, over: { status: null, assignee: "none", due: null }, active: filters.assignee === "none", tone: "warn" },
    { key: "late", label: t.quick.late, count: counts.late, over: { status: null, assignee: null, due: "late" }, active: filters.due === "late", tone: "bad" },
    { key: "done", label: t.quick.done, over: { status: "done", assignee: null, due: null }, active: list.applied.status === "done" },
  ];

  return (
    <>
      <PageHeader
        title={t.title}
        description={t.intro}
        actions={
          can(staff.actor, "tasks.work").allowed && units.length ? (
            <details className="relative">
              <summary className={`${secondaryButton} cursor-pointer list-none`}>
                <Wrench className="size-4" aria-hidden />
                {t.reportTitle}
              </summary>
              <form action={reportMaintenanceAction} className="absolute right-0 z-20 mt-2 grid w-[min(28rem,90vw)] gap-3 rounded-xl border border-line bg-white p-4 shadow-xl">
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
                <label className="space-y-1 text-xs text-stone">
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
                <button type="submit" className="rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
                  {t.reportSubmit}
                </button>
              </form>
            </details>
          ) : null
        }
      />
      <div className="mb-4 space-y-2">
        {doneText ? <SuccessNote>{doneText}</SuccessNote> : null}
        <ErrorNote>{errorText ? `${errorText}${one(sp.codes) ? ` (${one(sp.codes)})` : ""}` : null}</ErrorNote>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {quick.map((q) => (
          <Link
            key={q.key}
            href={href(q.over)}
            aria-current={q.active ? "true" : undefined}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${q.active ? "border-lagoon bg-lagoon text-ivory" : "border-line bg-white text-ink hover:border-lagoon/40"}`}
          >
            {q.label}
            {q.count !== undefined ? (
              <span className={`font-semibold tabular-nums ${q.active ? "" : q.tone === "bad" && q.count ? "text-danger" : q.tone === "warn" && q.count ? "text-terracotta-deep" : ""}`}>{q.count}</span>
            ) : null}
          </Link>
        ))}
      </div>

      <FilterForm action={base} className="mb-4 flex flex-wrap items-center gap-2">
        <select name="status" defaultValue={list.applied.status === "active" ? "" : list.applied.status} aria-label={t.table.status} className={filterClass}>
          <option value="">{f.active}</option>
          {(["open", "in_progress", "done", "cancelled"] as const).map((s) => (
            <option key={s} value={s}>
              {statusLabels[s]}
            </option>
          ))}
          <option value="all">{f.all}</option>
        </select>
        <select name="kind" defaultValue={list.applied.kind} aria-label={f.allKinds} className={filterClass}>
          <option value="">{f.allKinds}</option>
          {TASK_KINDS.map((k) => (
            <option key={k} value={k}>
              {kinds[k]}
            </option>
          ))}
        </select>
        <select name="assignee" defaultValue={filters.assignee} aria-label={t.table.assignee} className={filterClass}>
          <option value="">{f.allPeople}</option>
          <option value="me">{f.me}</option>
          <option value="none">{f.nobody}</option>
          {everyone.map((p) => (
            <option key={p.id} value={p.id}>
              {p.fullName}
            </option>
          ))}
        </select>
        {all.length > 1 ? (
          <select name="property" defaultValue={chosen?.slug ?? ""} aria-label={f.allProperties} className={filterClass}>
            <option value="">{f.allProperties}</option>
            {all.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        ) : null}
        <select name="due" defaultValue={list.applied.due} aria-label={t.table.due} className={filterClass}>
          <option value="">{f.anyDue}</option>
          <option value="late">{f.late}</option>
          <option value="today">{f.today}</option>
          <option value="week">{f.week}</option>
          <option value="none">{f.none}</option>
        </select>
        <input type="search" name="q" defaultValue={filters.q} placeholder={f.search} aria-label={f.search} className={`${filterClass} w-full sm:w-64`} />
        {current.size ? (
          <Link href={base} className="text-sm text-lagoon hover:underline">
            {f.reset}
          </Link>
        ) : null}
      </FilterForm>

      <Card bodyClassName="" title={format(f.count, { count: list.total })}>
        {list.rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="border-b border-line/70 text-xs text-stone">
                <tr>
                  <th className="px-5 py-2.5 font-medium">{t.table.task}</th>
                  <th className="px-3 py-2.5 font-medium">{t.table.villa}</th>
                  <th className="px-3 py-2.5 font-medium">{t.table.due}</th>
                  <th className="px-3 py-2.5 font-medium">{t.table.assignee}</th>
                  <th className="px-3 py-2.5 font-medium">{t.table.status}</th>
                  <th className="px-5 py-2.5 text-right font-medium">{t.table.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {list.rows.map((r) => {
                  const task = r.task;
                  const active = task.status === "open" || task.status === "in_progress";
                  const u = urgency(task, today, nowTime);
                  const canWork = can(staff.actor, "tasks.work", task.propertyId).allowed;
                  const canAssign = can(staff.actor, "tasks.assign", task.propertyId).allowed;
                  const hidden = (
                    <>
                      <input type="hidden" name="lang" value={lang} />
                      <input type="hidden" name="taskId" value={task.id} />
                      <input type="hidden" name="filters" value={current.toString()} />
                    </>
                  );
                  const detail = `/${lang}/ops/tasks/${task.id}`;
                  return (
                    <tr key={task.id} id={`task-${task.id}`} className={`scroll-mt-24 align-top ${u === "late" ? "bg-danger/[0.03]" : ""}`}>
                      <td className="max-w-[22rem] px-5 py-3">
                        <Link href={detail} className="font-medium text-ink hover:text-lagoon hover:underline">
                          {titleOf(task)}
                        </Link>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Pill>{kinds[task.kind]}</Pill>
                          {task.blockId ? <Pill tone="bad">{t.villaBlocked}</Pill> : null}
                        </span>
                        {task.notes ? <p className="mt-1 line-clamp-2 text-xs text-stone">{task.notes}</p> : null}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">
                        <span className="font-mono text-xs text-ink">{r.unitCode ?? "—"}</span>
                        {r.reservationCode ? (
                          <Link href={`/${lang}/ops/reservations/${r.reservationCode}`} className="block font-mono text-xs text-lagoon hover:underline">
                            {r.reservationCode}
                          </Link>
                        ) : null}
                        {all.length > 1 ? <span className="block text-xs text-stone">{r.propertyName}</span> : null}
                      </td>
                      <td className="px-3 py-3 text-xs">
                        {!active && task.completedAt ? (
                          <span className="text-stone">{format(t.table.finished, { when: when.format(task.completedAt) })}</span>
                        ) : task.dueDate ? (
                          <span className={u === "late" ? "font-medium text-danger" : u === "soon" ? "font-medium text-terracotta-deep" : "text-ink"}>
                            {u === "late" ? `${t.late} · ` : ""}
                            {task.dueDate === today ? format(t.dueToday, { time: task.dueTime?.slice(0, 5) ?? "" }) : format(t.dueOn, { date: formatDate(task.dueDate, lang), time: task.dueTime?.slice(0, 5) ?? "" })}
                          </span>
                        ) : (
                          <span className="text-stone">{t.table.noDue}</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {active && canAssign ? (
                          <form action={assignTaskAction} className="flex gap-1">
                            {hidden}
                            <select name="assigneeId" defaultValue={task.assigneeId ?? ""} aria-label={t.table.assignee} className="max-w-[11rem] rounded-lg border border-line bg-white px-2 py-1 text-xs text-ink">
                              <option value="">{t.nobody}</option>
                              {(people.get(task.propertyId) ?? []).map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.fullName}
                                </option>
                              ))}
                            </select>
                            <button type="submit" className="rounded-lg border border-line px-2 py-1 text-xs text-ink hover:bg-sand">
                              {t.assign}
                            </button>
                          </form>
                        ) : (
                          <span className={r.assigneeName ? "text-ink" : "text-stone"}>{r.assigneeName ?? t.nobody}</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <Pill tone={task.status === "done" ? "good" : task.status === "cancelled" ? "neutral" : task.status === "in_progress" ? "info" : "warn"}>{statusLabels[task.status]}</Pill>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {active && canWork && !task.assigneeId ? (
                            <form action={claimTaskAction}>
                              {hidden}
                              <button type="submit" className="rounded-lg border border-lagoon px-3 py-1.5 text-xs font-medium text-lagoon hover:bg-lagoon-soft">
                                {t.claim}
                              </button>
                            </form>
                          ) : null}
                          {active && canWork && task.status === "open" && (task.assigneeId === staff.staffId || !task.assigneeId) ? (
                            <form action={startTaskAction}>
                              {hidden}
                              <button type="submit" className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink hover:bg-sand">
                                {t.start}
                              </button>
                            </form>
                          ) : null}
                          <Link href={detail} className={active && canWork ? "rounded-lg bg-lagoon px-3 py-1.5 text-xs font-medium text-ivory hover:bg-lagoon-deep" : "rounded-lg border border-line px-3 py-1.5 text-xs text-ink hover:bg-sand"}>
                            {active && canWork ? t.table.finish : t.table.open}
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-5 py-6 text-sm text-stone">{f.empty}</p>
        )}
        {list.pages > 1 ? (
          <div className="flex items-center justify-between gap-3 border-t border-line/70 px-5 py-3 text-sm">
            <span className="text-stone">{format(f.page, { page: list.page, pages: list.pages })}</span>
            <span className="flex gap-2">
              {list.page > 1 ? (
                <Link href={href({ page: String(list.page - 1) })} className={secondaryButton}>
                  {f.prev}
                </Link>
              ) : null}
              {list.page < list.pages ? (
                <Link href={href({ page: String(list.page + 1) })} className={secondaryButton}>
                  {f.next}
                </Link>
              ) : null}
            </span>
          </div>
        ) : null}
      </Card>

      {types.some((ty) => can(staff.actor, "tasks.configure", ty.propertyId).allowed) ? (
        <details id="checklists" className="mt-6 rounded-2xl border border-line/80 bg-white p-5 shadow-sm">
          <summary className="cursor-pointer text-sm font-semibold text-ink">{t.checklistsTitle}</summary>
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
                    <textarea name="items" rows={7} defaultValue={(ty.content.inspectionChecklist?.length ? ty.content.inspectionChecklist : Object.values(t.defaultChecklist)).join("\n")} className={input} />
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
