import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { FilterForm } from "@/components/ops/filter-form";
import { NoAccess } from "@/components/ops/ops-shell";
import { Card, filterClass, PageHeader, secondaryButton } from "@/components/ops/ui";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { addDays } from "@/domain/dates";
import type { Readiness } from "@/domain/housekeeping";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { changeUnitStateAction, createBlockAction, resolveBlockAction } from "@/lib/ops/housekeeping-actions";
import { villaStatus, visibleProperties } from "@/lib/ops/queries";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/villa-status">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).villaStatus.title };
}

export default async function VillaStatusPage({ params, searchParams }: PageProps<"/[lang]/ops/villa-status">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
      <Board lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

const tone: Record<Readiness, string> = {
  maintenance: "bg-danger/10 text-danger border-danger/30",
  dirty: "bg-terracotta/10 text-terracotta-deep border-terracotta/30",
  inspect: "bg-sand text-ink border-line",
  occupied: "bg-lagoon-soft text-lagoon border-lagoon/20",
  ready: "bg-success/10 text-success border-success/30",
};
const READINESS: Readiness[] = ["maintenance", "dirty", "inspect", "occupied", "ready"];

function one(v: string | string[] | undefined) {
  return typeof v === "string" ? v : undefined;
}

async function Board({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "villa_status.view").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const sp = await searchParams;
  const t = dict.villaStatus;
  const f = t.filters;
  const properties = (await visibleProperties(staff.actor)).filter((p) => can(staff.actor, "villa_status.view", p.id).allowed);
  const chosen = properties.find((p) => p.slug === one(sp.property)) ?? null;
  const now = new Date();
  const boards = await Promise.all((chosen ? [chosen] : properties).map((p) => villaStatus(staff.actor, p.slug, now)));
  const rows = boards.flatMap((b) => b.units.map((u) => ({ ...u, property: b.property!, today: b.today })));

  const filters = {
    state: READINESS.find((r) => r === one(sp.state)) ?? "",
    type: one(sp.type) ?? "",
    attention: one(sp.attention) === "1",
    today: one(sp.today) === "arrival" || one(sp.today) === "departure" ? (one(sp.today) as "arrival" | "departure") : "",
    q: (one(sp.q) ?? "").trim().toLowerCase().slice(0, 60),
  };
  const types = [...new Set(rows.map((r) => r.typeName))].sort();
  const shown = rows
    .filter((u) => !filters.state || u.readiness === filters.state)
    .filter((u) => !filters.type || u.typeName === filters.type)
    .filter((u) => !filters.attention || u.needsAttention)
    .filter((u) => (filters.today === "arrival" ? Boolean(u.arrival) : filters.today === "departure" ? u.departingToday : true))
    .filter((u) => {
      if (!filters.q) return true;
      const hay = [u.code, u.name, u.typeName, u.inHouse?.guestName, u.arrival?.guestName].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(filters.q);
    })
    .sort((a, b) => a.priority - b.priority || a.property.name.localeCompare(b.property.name) || a.code.localeCompare(b.code));

  // The current filters, sent with each action so it comes back to the same view.
  const current = new URLSearchParams();
  for (const k of ["property", "state", "type", "attention", "today", "q"]) {
    const v = one(sp[k]);
    if (v) current.set(k, v);
  }
  const error = one(sp.error);
  const errorText = error ? format((t.errors as Record<string, string>)[error] ?? t.errors.not_found, { codes: one(sp.codes) ?? "" }) : null;
  const timeFmt = new Intl.DateTimeFormat(lang === "id" ? "id-ID" : "en-GB", { dateStyle: "short", timeStyle: "short", timeZone: properties[0]?.timezone ?? "Asia/Makassar" });
  const count = (r: Readiness) => rows.filter((u) => u.readiness === r).length;
  const hidden = (u: (typeof rows)[number]) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="property" value={u.property.slug} />
      <input type="hidden" name="unitId" value={u.id} />
      <input type="hidden" name="filters" value={current.toString()} />
    </>
  );
  const base = `/${lang}/ops/villa-status`;

  return (
    <>
      <PageHeader title={t.title} description={t.intro} />
      <div className="mb-4 space-y-2">
        {one(sp.done) ? <SuccessNote>{t.done}</SuccessNote> : null}
        {errorText ? <ErrorNote>{errorText}</ErrorNote> : null}
      </div>

      {/* Counts by status: one click filters the table. */}
      <div className="mb-4 flex flex-wrap gap-2">
        {READINESS.map((r) => {
          const active = filters.state === r;
          const q = new URLSearchParams(current);
          if (active) q.delete("state");
          else q.set("state", r);
          return (
            <Link key={r} href={`${base}?${q}`} aria-current={active ? "true" : undefined} className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${active ? "border-lagoon bg-lagoon text-ivory" : "border-line bg-white text-ink hover:border-lagoon/40"}`}>
              <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${active ? "border-ivory/30 bg-ivory/10 text-ivory" : tone[r]}`}>{t.readiness[r]}</span>
              <span className="font-semibold tabular-nums">{count(r)}</span>
            </Link>
          );
        })}
      </div>

      <FilterForm action={base} className="mb-4 flex flex-wrap items-center gap-2">
        {properties.length > 1 ? (
          <select name="property" defaultValue={chosen?.slug ?? ""} aria-label={f.allProperties} className={filterClass}>
            <option value="">{f.allProperties}</option>
            {properties.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        ) : null}
        <select name="state" defaultValue={filters.state} aria-label={f.allStates} className={filterClass}>
          <option value="">{f.allStates}</option>
          {READINESS.map((r) => (
            <option key={r} value={r}>
              {t.readiness[r]}
            </option>
          ))}
        </select>
        <select name="type" defaultValue={filters.type} aria-label={f.allTypes} className={filterClass}>
          <option value="">{f.allTypes}</option>
          {types.map((ty) => (
            <option key={ty} value={ty}>
              {ty}
            </option>
          ))}
        </select>
        <select name="today" defaultValue={filters.today} aria-label={f.anyDay} className={filterClass}>
          <option value="">{f.anyDay}</option>
          <option value="arrival">{f.arrival}</option>
          <option value="departure">{f.departure}</option>
        </select>
        <label className="flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink">
          <input type="checkbox" name="attention" value="1" defaultChecked={filters.attention} className="size-4 accent-lagoon" />
          {f.attention}
        </label>
        <input type="search" name="q" defaultValue={one(sp.q) ?? ""} placeholder={f.search} aria-label={f.search} className={`${filterClass} w-full sm:w-56`} />
        {current.size ? (
          <Link href={base} className="text-sm text-lagoon hover:underline">
            {f.reset}
          </Link>
        ) : null}
      </FilterForm>

      <Card bodyClassName="" title={format(f.count, { count: shown.length })}>
        {shown.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-left text-sm">
              <thead className="border-b border-line/70 text-xs text-stone">
                <tr>
                  <th className="px-5 py-2.5 font-medium">{t.table.villa}</th>
                  <th className="px-3 py-2.5 font-medium">{t.table.status}</th>
                  <th className="px-3 py-2.5 font-medium">{t.table.inHouse}</th>
                  <th className="px-3 py-2.5 font-medium">{t.table.arrival}</th>
                  <th className="px-3 py-2.5 font-medium">{t.table.maintenance}</th>
                  <th className="px-3 py-2.5 font-medium">{t.table.lastChange}</th>
                  <th className="px-5 py-2.5 text-right font-medium">{t.table.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {shown.map((u) => {
                  const canUpdate = can(staff.actor, "housekeeping.update", u.property.id).allowed;
                  const canBlock = can(staff.actor, "unit.block", u.property.id).allowed;
                  const blocks = [u.blockToday, ...u.upcomingBlocks].filter((b): b is NonNullable<typeof b> => Boolean(b));
                  return (
                    <tr key={u.id} id={`unit-${u.id}`} className={`scroll-mt-24 align-top ${u.priority === 0 ? "bg-danger/[0.03]" : ""}`}>
                      <td className="px-5 py-3">
                        <p className="font-medium text-ink">{u.name}</p>
                        <p className="font-mono text-xs text-stone">
                          {u.code} · {u.typeName}
                          {properties.length > 1 ? ` · ${u.property.name}` : ""}
                        </p>
                      </td>
                      <td className="px-3 py-3">
                        <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone[u.readiness]}`}>{t.readiness[u.readiness]}</span>
                        {u.priority === 0 ? <span className="mt-1 block text-xs font-medium text-danger">{t.urgent}</span> : null}
                        {u.priority === 1 ? <span className="mt-1 block text-xs font-medium text-terracotta-deep">{t.turnover}</span> : null}
                      </td>
                      <td className="px-3 py-3">
                        {u.inHouse ? (
                          <>
                            <Link href={`/${lang}/ops/reservations/${u.inHouse.code}`} className="font-medium text-lagoon hover:underline">
                              {u.inHouse.guestName}
                            </Link>
                            <span className="block text-xs text-stone">{formatDate(u.inHouse.checkOut, lang)}</span>
                            {u.departingToday ? <span className="mt-1 inline-block rounded bg-sand px-1.5 py-0.5 text-xs">{t.departing}</span> : null}
                            {u.lateCheckout ? (
                              <span className={`mt-1 block text-xs ${u.lateCheckout.conflict ? "text-danger" : u.lateCheckout.approved ? "text-terracotta-deep" : "text-stone"}`}>
                                {format(u.lateCheckout.approved ? t.lateCheckout : t.lateRequested, { time: u.lateCheckout.time })}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-stone">{t.nothing}</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {u.arrival ? (
                          <>
                            <Link href={`/${lang}/ops/reservations/${u.arrival.code}`} className="font-medium text-lagoon hover:underline">
                              {u.arrival.guestName}
                            </Link>
                            <span className="block text-xs text-stone">{u.arrival.eta ? format(t.eta, { time: u.arrival.eta.slice(0, 5) }) : t.noEta}</span>
                            {u.earlyCheckin ? (
                              <span className={`mt-1 block text-xs ${u.earlyCheckin.conflict ? "text-danger" : u.earlyCheckin.approved ? "text-terracotta-deep" : "text-stone"}`}>
                                {format(u.earlyCheckin.approved ? t.earlyCheckin : t.earlyRequested, { time: u.earlyCheckin.time })}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-stone">{t.nothing}</span>
                        )}
                      </td>
                      <td className="max-w-[16rem] px-3 py-3 text-xs">
                        {u.blockToday ? <p className="text-danger">{format(t.blockToday, { date: formatDate(u.blockToday.endDate, lang), reason: u.blockToday.reason })}</p> : null}
                        {u.upcomingBlocks.map((b) => (
                          <p key={b.id} className="text-stone">
                            {format(t.upcomingBlock, { from: formatDate(b.startDate, lang), to: formatDate(b.endDate, lang), reason: b.reason })}
                          </p>
                        ))}
                        {!blocks.length ? <span className="text-stone">{t.nothing}</span> : null}
                      </td>
                      <td className="px-3 py-3 text-xs text-stone">
                        {u.lastChange
                          ? format(t.lastChange, { state: t.readiness[u.lastChange.toState], who: u.lastChange.actorName ?? t.someone, time: timeFmt.format(u.lastChange.occurredAt) })
                          : t.nothing}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {canUpdate && !u.inHouse ? (
                            <>
                              {u.state === "dirty" ? <StateButton hidden={hidden(u)} to="inspect" label={t.markCleaned} primary /> : null}
                              {u.state === "inspect" ? (
                                <>
                                  <StateButton hidden={hidden(u)} to="ready" label={t.markInspected} primary />
                                  <StateButton hidden={hidden(u)} to="dirty" label={t.failInspection} />
                                </>
                              ) : null}
                              {u.state === "ready" ? <StateButton hidden={hidden(u)} to="dirty" label={t.markDirty} /> : null}
                            </>
                          ) : null}
                          {canBlock ? (
                            <details className="relative">
                              <summary className={`${secondaryButton} cursor-pointer list-none px-3 py-1.5 text-xs`}>{t.blockMenu}</summary>
                              <div className="absolute right-0 z-20 mt-1 w-80 space-y-3 rounded-xl border border-line bg-white p-4 text-left shadow-xl">
                                {blocks.map((b) => (
                                  <form key={b.id} action={resolveBlockAction}>
                                    {hidden(u)}
                                    <input type="hidden" name="blockId" value={b.id} />
                                    <button type="submit" className="w-full rounded-lg border border-line px-3 py-1.5 text-left text-xs text-ink hover:bg-sand">
                                      {t.resolve}: {b.reason}
                                    </button>
                                  </form>
                                ))}
                                <form action={createBlockAction} className="grid gap-2">
                                  {hidden(u)}
                                  <p className="text-xs font-semibold text-ink">{t.blockTitle}</p>
                                  <div className="grid grid-cols-2 gap-2">
                                    <Labeled label={t.blockFrom}>
                                      <input type="date" name="startDate" required defaultValue={u.today} min={u.today} className="w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm" />
                                    </Labeled>
                                    <Labeled label={t.blockTo}>
                                      <input type="date" name="endDate" required defaultValue={addDays(u.today, 1)} min={addDays(u.today, 1)} className="w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm" />
                                    </Labeled>
                                  </div>
                                  <Labeled label={t.blockReason}>
                                    <input name="reason" required maxLength={300} className="w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm" />
                                  </Labeled>
                                  <button type="submit" className="rounded-lg border border-danger px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/5">
                                    {t.blockSubmit}
                                  </button>
                                </form>
                              </div>
                            </details>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-5 py-6 text-sm text-stone">{rows.length ? f.none : t.empty}</p>
        )}
      </Card>
    </>
  );
}

function StateButton({ hidden, to, label, primary }: { hidden: ReactNode; to: string; label: string; primary?: boolean }) {
  return (
    <form action={changeUnitStateAction}>
      {hidden}
      <input type="hidden" name="to" value={to} />
      <button
        type="submit"
        className={primary ? "rounded-lg bg-lagoon px-3 py-1.5 text-xs font-medium text-ivory hover:bg-lagoon-deep" : "rounded-lg border border-line bg-white px-3 py-1.5 text-xs text-ink hover:bg-sand"}
      >
        {label}
      </button>
    </form>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1 text-xs text-stone">
      <span>{label}</span>
      {children}
    </label>
  );
}
