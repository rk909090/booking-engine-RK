import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { BarChart } from "@/components/ops/bar-chart";
import { NoAccess, OpsNav, OpsShell } from "@/components/ops/ops-shell";
import { ReportTabs } from "@/components/ops/report-tabs";
import { addDays } from "@/domain/dates";
import { ratios, rollup, type Perf } from "@/domain/reports";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatDateRange, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { buildReport } from "@/lib/ops/reports";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/reports">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).reports.title };
}

export default async function ReportsPage({ params, searchParams }: PageProps<"/[lang]/ops/reports">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <OpsShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Report lang={lang} dict={dict} searchParams={searchParams} />
      </Suspense>
    </OpsShell>
  );
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";

async function Report({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "performance.view").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const t = dict.reports;
  const sp = await searchParams;
  const report = await buildReport(staff.actor, { property: one(sp.property), from: one(sp.from), to: one(sp.to) });
  const { current: cur, previous: prev, units } = report;
  const locale = lang === "id" ? "id-ID" : "en-GB";
  const pct = (x: number) => `${(x * 100).toLocaleString(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`;
  const num = (x: number, digits = 0) => x.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits });
  const money = (x: number) => formatMoney(x, lang);
  const qs = (over: Record<string, string>) =>
    new URLSearchParams({ ...(report.property ? { property: report.property.slug } : {}), from: report.from, to: report.to, ...over }).toString();
  const csvHref = (section: string) => `/api/ops/reports?${qs({ lang, section })}`;

  // Quick periods.
  const today = report.today;
  const monthStart = `${today.slice(0, 8)}01`;
  const lastMonthEnd = addDays(monthStart, -1);
  const presets = [
    { label: t.presets.thisMonth, from: monthStart, to: addDays(`${addDays(monthStart, 32).slice(0, 8)}01`, -1) },
    { label: t.presets.lastMonth, from: `${lastMonthEnd.slice(0, 8)}01`, to: lastMonthEnd },
    { label: t.presets.next30, from: today, to: addDays(today, 29) },
    { label: t.presets.yearToDate, from: `${today.slice(0, 4)}-01-01`, to: today },
  ];

  const cr = ratios(cur.perf.totals);
  const pr = ratios(prev.perf.totals);
  const change = (now: number, before: number) => (before > 0 ? (now - before) / before : null);
  const delta = (now: number, before: number, kind: "relative" | "points" = "relative") => {
    if (kind === "points") {
      const d = (now - before) * 100;
      return { text: `${d >= 0 ? "+" : "−"}${num(Math.abs(d), 1)} ${t.points}`, up: d >= 0 };
    }
    const c = change(now, before);
    return c === null ? null : { text: `${c >= 0 ? "+" : "−"}${num(Math.abs(c) * 100, 1)}%`, up: c >= 0 };
  };

  const bucketLabel = (key: string) => (key.length === 7 ? formatDate(`${key}-01`, lang, { month: "long", year: "numeric" }) : formatDate(key, lang));
  const bucketShort = (key: string) => (key.length === 7 ? formatDate(`${key}-01`, lang, { month: "short" }) : String(Number(key.slice(8))));
  const series = cur.perf.series;

  const byType = rollup(cur.perf.byUnit, units, "unitTypeId");
  const byTypePrev = rollup(prev.perf.byUnit, units, "unitTypeId");
  const byProperty = rollup(cur.perf.byUnit, units, "propertyId");
  const byPropertyPrev = rollup(prev.perf.byUnit, units, "propertyId");
  const typeName = (id: string) => units.find((u) => u.unitTypeId === id)?.typeName ?? "";
  const propertyName = (id: string) => units.find((u) => u.propertyId === id)?.propertyName ?? "";

  const sources = [...cur.made.bySource.entries()].sort((a, b) => b[1].value - a[1].value);

  return (
    <>
      <OpsNav lang={lang} dict={dict} staff={staff} current="reports" />
      <h1 className="font-display text-3xl text-lagoon">{t.title}</h1>
      <ReportTabs lang={lang} dict={dict} current="period" property={report.property?.slug ?? null} />
      <p className="mt-3 max-w-3xl text-sm text-stone">{t.intro}</p>

      <form method="get" className="mt-5 grid gap-3 rounded-xl border border-line bg-white/70 p-4 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_auto] lg:items-end">
        <label className="space-y-1 text-xs text-stone">
          <span>{t.property}</span>
          <select name="property" defaultValue={report.property?.slug ?? ""} className={input}>
            <option value="">{t.allProperties}</option>
            {report.properties.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{t.from}</span>
          <input type="date" name="from" required defaultValue={report.from} className={input} />
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{t.to}</span>
          <input type="date" name="to" required defaultValue={report.to} className={input} />
        </label>
        <button type="submit" className="rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
          {t.apply}
        </button>
        <div className="flex flex-wrap gap-2 text-xs sm:col-span-2 lg:col-span-4">
          {presets.map((p) => (
            <Link key={p.label} href={`/${lang}/ops/reports?${qs({ from: p.from, to: p.to })}`} className="rounded-full border border-line px-3 py-1 text-ink hover:bg-sand">
              {p.label}
            </Link>
          ))}
        </div>
      </form>

      <p className="mt-4 text-sm text-ink">
        {format(t.period, { range: formatDateRange(report.from, report.to, lang), previous: formatDateRange(prev.from, prev.to, lang) })}
      </p>
      <p className="text-xs text-stone">{t.basis}</p>

      {/* Room performance */}
      <Section title={t.perfTitle} csv={csvHref("villas")} csvLabel={t.csv}>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Tile label={t.occupancy} value={pct(cr.occupancy)} previous={pct(pr.occupancy)} delta={delta(cr.occupancy, pr.occupancy, "points")} t={t} />
          <Tile label={t.adr} value={money(cr.adr)} previous={money(pr.adr)} delta={delta(cr.adr, pr.adr)} t={t} />
          <Tile label={t.revpar} value={money(cr.revpar)} previous={money(pr.revpar)} delta={delta(cr.revpar, pr.revpar)} t={t} />
          <Tile label={t.revenue} value={money(cur.perf.totals.revenue)} previous={money(prev.perf.totals.revenue)} delta={delta(cur.perf.totals.revenue, prev.perf.totals.revenue)} t={t} />
          <Tile
            label={t.soldNights}
            value={`${num(cur.perf.totals.sold)} / ${num(cur.perf.totals.available)}`}
            previous={`${num(prev.perf.totals.sold)} / ${num(prev.perf.totals.available)}`}
            delta={delta(cur.perf.totals.sold, prev.perf.totals.sold)}
            t={t}
          />
          <Tile label={t.extras} value={money(cur.perf.totals.extras)} previous={money(prev.perf.totals.extras)} delta={delta(cur.perf.totals.extras, prev.perf.totals.extras)} t={t} />
        </ul>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <BarChart
            title={cur.perf.bucket === "day" ? t.occupancyByDay : t.occupancyByMonth}
            points={series.map((s) => ({ key: s.key, label: bucketLabel(s.key), short: bucketShort(s.key), value: ratios(s).occupancy }))}
            max={1}
            format={pct}
            tableLabel={t.asTable}
            columnLabel={t.occupancy}
          />
          <BarChart
            title={cur.perf.bucket === "day" ? t.revenueByDay : t.revenueByMonth}
            points={series.map((s) => ({ key: s.key, label: bucketLabel(s.key), short: bucketShort(s.key), value: s.revenue }))}
            format={money}
            tableLabel={t.asTable}
            columnLabel={t.revenue}
          />
        </div>
        <p className="mt-2 text-right text-xs">
          <a href={csvHref("series")} className="text-lagoon hover:underline">
            {cur.perf.bucket === "day" ? t.csvDaily : t.csvMonthly}
          </a>
        </p>

        <PerfTable
          title={report.properties.length > 1 && !report.property ? t.byProperty : t.byType}
          rows={(report.properties.length > 1 && !report.property ? [...byProperty] : [...byType]).map(([id, p]) => ({
            key: id,
            name: report.properties.length > 1 && !report.property ? propertyName(id) : typeName(id),
            p,
            prev: (report.properties.length > 1 && !report.property ? byPropertyPrev : byTypePrev).get(id),
          }))}
          total={cur.perf.totals}
          prevTotal={prev.perf.totals}
          t={t}
          pct={pct}
          num={num}
          money={money}
        />
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-lagoon">{t.byVilla}</summary>
          <PerfTable
            rows={units
              .filter((u) => cur.perf.byUnit.has(u.id))
              .map((u) => ({ key: u.id, name: `${u.code} · ${u.typeName}`, p: cur.perf.byUnit.get(u.id)!, prev: prev.perf.byUnit.get(u.id) }))}
            t={t}
            pct={pct}
            num={num}
            money={money}
          />
        </details>
      </Section>

      {/* Bookings made */}
      <Section title={t.madeTitle} intro={t.madeIntro} csv={csvHref("bookings")} csvLabel={t.csv}>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Tile label={t.madeCount} value={num(cur.made.count)} previous={num(prev.made.count)} delta={delta(cur.made.count, prev.made.count)} t={t} />
          <Tile label={t.madeNights} value={num(cur.made.nights)} previous={num(prev.made.nights)} delta={delta(cur.made.nights, prev.made.nights)} t={t} />
          <Tile label={t.madeValue} value={money(cur.made.value)} previous={money(prev.made.value)} delta={delta(cur.made.value, prev.made.value)} t={t} />
          <Tile label={t.leadTime} value={format(t.days, { count: num(cur.made.avgLeadDays, 1) })} previous={format(t.days, { count: num(prev.made.avgLeadDays, 1) })} t={t} />
          <Tile label={t.avgStay} value={format(t.nights, { count: num(cur.made.avgNights, 1) })} previous={format(t.nights, { count: num(prev.made.avgNights, 1) })} t={t} />
          <Tile
            label={t.discounts}
            value={`${num(cur.made.discountedCount)} · ${money(cur.made.discountTotal)}`}
            previous={`${num(prev.made.discountedCount)} · ${money(prev.made.discountTotal)}`}
            t={t}
          />
        </ul>
        {sources.length ? (
          <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-white/70">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="border-b border-line text-xs uppercase tracking-wider text-stone">
                <tr>
                  <th className="px-4 py-2">{t.source}</th>
                  <th className="px-4 py-2 text-right">{t.madeCount}</th>
                  <th className="px-4 py-2 text-right">{t.madeNights}</th>
                  <th className="px-4 py-2 text-right">{t.madeValue}</th>
                  <th className="px-4 py-2 text-right">{t.share}</th>
                </tr>
              </thead>
              <tbody>
                {sources.map(([source, s]) => (
                  <tr key={source} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-2 text-ink">{(dict.resList.sources as Record<string, string>)[source] ?? source}</td>
                    <td className="px-4 py-2 text-right text-ink">{num(s.count)}</td>
                    <td className="px-4 py-2 text-right text-ink">{num(s.nights)}</td>
                    <td className="px-4 py-2 text-right text-ink">{money(s.value)}</td>
                    <td className="px-4 py-2 text-right text-stone">{pct(cur.made.value > 0 ? s.value / cur.made.value : 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-4 text-sm text-stone">{t.noBookings}</p>
        )}
      </Section>

      {/* Cancellations and no-shows */}
      <Section title={t.lostTitle} intro={t.lostIntro} csv={csvHref("lost")} csvLabel={t.csv}>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label={t.cancellations}
            value={`${num(cur.lost.cancelled.count)} · ${pct(cur.lost.cancelled.rate)}`}
            previous={`${num(prev.lost.cancelled.count)} · ${pct(prev.lost.cancelled.rate)}`}
            t={t}
          />
          <Tile label={t.cancelledValue} value={money(cur.lost.cancelled.value)} previous={money(prev.lost.cancelled.value)} note={format(t.keptNote, { amount: money(cur.lost.cancelled.kept) })} t={t} />
          <Tile
            label={t.noShows}
            value={`${num(cur.lost.noShows.count)} · ${pct(cur.lost.noShows.rate)}`}
            previous={`${num(prev.lost.noShows.count)} · ${pct(prev.lost.noShows.rate)}`}
            t={t}
          />
          <Tile label={t.noShowValue} value={money(cur.lost.noShows.value)} previous={money(prev.lost.noShows.value)} note={format(t.keptNote, { amount: money(cur.lost.noShows.kept) })} t={t} />
        </ul>
        <p className="mt-2 text-xs text-stone">{t.ratesNote}</p>
      </Section>
    </>
  );
}

type T = Dictionary["reports"];

function Section({ title, intro, csv, csvLabel, children }: { title: string; intro?: string; csv: string; csvLabel: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-display text-2xl text-lagoon">{title}</h2>
          {intro ? <p className="text-xs text-stone">{intro}</p> : null}
        </div>
        <a href={csv} className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink hover:bg-sand">
          {csvLabel}
        </a>
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Tile({ label, value, previous, delta, note, t }: { label: string; value: string; previous: string; delta?: { text: string; up: boolean } | null; note?: string; t: T }) {
  return (
    <li className="rounded-xl border border-line bg-white/70 p-4">
      <span className="block text-xs text-stone">{label}</span>
      <span className="mt-1 block break-words font-display text-xl text-ink">{value}</span>
      <span className="mt-1 block text-xs text-stone">
        {format(t.lastYear, { value: previous })}
        {delta ? (
          <span className="ml-1 font-medium text-ink">
            <span aria-hidden>{delta.up ? "▲" : "▼"}</span> {delta.text}
          </span>
        ) : null}
      </span>
      {note ? <span className="mt-1 block text-xs text-stone">{note}</span> : null}
    </li>
  );
}

function PerfTable({
  title,
  rows,
  total,
  prevTotal,
  t,
  pct,
  num,
  money,
}: {
  title?: string;
  rows: Array<{ key: string; name: string; p: Perf; prev?: Perf }>;
  total?: Perf;
  prevTotal?: Perf;
  t: T;
  pct: (x: number) => string;
  num: (x: number) => string;
  money: (x: number) => string;
}) {
  const line = (name: string, p: Perf, prev: Perf | undefined, strong = false) => {
    const r = ratios(p);
    return (
      <tr className={`border-b border-line/60 last:border-0 ${strong ? "font-medium" : ""}`}>
        <td className="px-4 py-2 text-ink">{name}</td>
        <td className="px-4 py-2 text-right text-ink">
          {num(p.sold)} / {num(p.available)}
        </td>
        <td className="px-4 py-2 text-right text-ink">
          {pct(r.occupancy)}
          {prev ? <span className="block text-[11px] font-normal text-stone">{pct(ratios(prev).occupancy)}</span> : null}
        </td>
        <td className="px-4 py-2 text-right text-ink">{money(r.adr)}</td>
        <td className="px-4 py-2 text-right text-ink">{money(r.revpar)}</td>
        <td className="px-4 py-2 text-right text-ink">
          {money(p.revenue)}
          {prev ? <span className="block text-[11px] font-normal text-stone">{money(prev.revenue)}</span> : null}
        </td>
        <td className="px-4 py-2 text-right text-stone">{money(p.extras)}</td>
      </tr>
    );
  };
  return (
    <div className="mt-4">
      {title ? <h3 className="mb-2 text-sm font-semibold uppercase tracking-[0.15em] text-terracotta-deep">{title}</h3> : null}
      <div className="overflow-x-auto rounded-xl border border-line bg-white/70">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-line text-xs uppercase tracking-wider text-stone">
            <tr>
              <th className="px-4 py-2" />
              <th className="px-4 py-2 text-right">{t.soldNights}</th>
              <th className="px-4 py-2 text-right">{t.occupancy}</th>
              <th className="px-4 py-2 text-right">{t.adr}</th>
              <th className="px-4 py-2 text-right">{t.revpar}</th>
              <th className="px-4 py-2 text-right">{t.revenue}</th>
              <th className="px-4 py-2 text-right">{t.extras}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <LineRow key={row.key}>{line(row.name, row.p, row.prev)}</LineRow>
            ))}
            {total ? line(t.total, total, prevTotal, true) : null}
          </tbody>
        </table>
      </div>
      {rows.some((r) => r.prev) ? <p className="mt-1 text-xs text-stone">{t.greyIsLastYear}</p> : null}
    </div>
  );
}

function LineRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
