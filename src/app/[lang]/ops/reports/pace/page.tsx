import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BarChart } from "@/components/ops/bar-chart";
import { NoAccess, OpsNav, OpsShell } from "@/components/ops/ops-shell";
import { ReportTabs } from "@/components/ops/report-tabs";
import { ratios, type Perf } from "@/domain/reports";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { buildPace, PACE_HORIZONS, PICKUP_DAYS } from "@/lib/ops/reports";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/reports/pace">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).reports.tabPace };
}

export default async function PacePage({ params, searchParams }: PageProps<"/[lang]/ops/reports/pace">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <OpsShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Pace lang={lang} dict={dict} searchParams={searchParams} />
      </Suspense>
    </OpsShell>
  );
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function Pace({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "performance.view").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const t = dict.reports;
  const sp = await searchParams;
  const pace = await buildPace(staff.actor, { property: one(sp.property), months: one(sp.months) });
  const locale = lang === "id" ? "id-ID" : "en-GB";
  const pct = (x: number) => `${(x * 100).toLocaleString(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`;
  const num = (x: number) => x.toLocaleString(locale);
  const money = (x: number) => formatMoney(x, lang);
  const signed = (x: number, f: (n: number) => string) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${f(Math.abs(x))}`;
  const qs = (over: Record<string, string>) =>
    new URLSearchParams({ ...(pace.property ? { property: pace.property.slug } : {}), months: String(pace.months), ...over }).toString();
  const lyKey = (key: string) => `${Number(key.slice(0, 4)) - 1}${key.slice(4)}`;
  const find = (series: Array<{ key: string } & Perf>, key: string) => series.find((s) => s.key === key);
  const monthName = (key: string) => formatDate(`${key}-01`, lang, { month: "long", year: "numeric" });

  const otb = pace.current.totals;
  const stly = pace.stly.totals;
  const week = pace.weekAgo.totals;
  const final = pace.lyFinal.totals;
  const change = (now: number, before: number) => (before > 0 ? `${signed(((now - before) / before) * 100, (n) => n.toLocaleString(locale, { maximumFractionDigits: 1 }))}%` : "—");

  return (
    <>
      <OpsNav lang={lang} dict={dict} staff={staff} current="reports" />
      <h1 className="font-display text-3xl text-lagoon">{t.title}</h1>
      <ReportTabs lang={lang} dict={dict} current="pace" property={pace.property?.slug ?? null} />
      <p className="mt-3 max-w-3xl text-sm text-stone">{t.paceIntro}</p>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-line bg-white/70 p-4">
        <input type="hidden" name="months" value={pace.months} />
        <label className="space-y-1 text-xs text-stone">
          <span className="block">{t.property}</span>
          <select name="property" defaultValue={pace.property?.slug ?? ""} className="w-56 rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink">
            <option value="">{t.allProperties}</option>
            {pace.properties.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
          {t.apply}
        </button>
        <div className="flex flex-wrap gap-2 text-xs" aria-label={t.horizon}>
          {PACE_HORIZONS.map((m) => (
            <Link
              key={m}
              href={`/${lang}/ops/reports/pace?${qs({ months: String(m) })}`}
              aria-current={m === pace.months ? "page" : undefined}
              className={m === pace.months ? "rounded-full bg-lagoon px-3 py-1 text-ivory" : "rounded-full border border-line px-3 py-1 text-ink hover:bg-sand"}
            >
              {format(t.monthsAhead, { count: m })}
            </Link>
          ))}
        </div>
      </form>

      <p className="mt-4 text-sm text-ink">
        {format(t.paceAsOf, {
          today: formatDate(pace.from, lang),
          to: formatDate(pace.to, lang),
          lyToday: formatDate(pace.lyFrom, lang),
          days: PICKUP_DAYS,
        })}
      </p>
      <p className="text-xs text-stone">{t.paceBasis}</p>

      <section className="mt-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="font-display text-2xl text-lagoon">{t.paceTitle}</h2>
          <a href={`/api/ops/reports?${qs({ lang, section: "pace" })}`} className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink hover:bg-sand">
            {t.csv}
          </a>
        </div>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label={t.otbNights} value={`${num(otb.sold)} · ${pct(ratios(otb).occupancy)}`} sub={format(t.stlyValue, { value: `${num(stly.sold)} · ${pct(ratios(stly).occupancy)}` })} />
          <Tile label={t.otbRevenue} value={money(otb.revenue)} sub={format(t.stlyValue, { value: `${money(stly.revenue)} (${change(otb.revenue, stly.revenue)})` })} />
          <Tile label={t.otbAdr} value={money(ratios(otb).adr)} sub={format(t.stlyValue, { value: money(ratios(stly).adr) })} />
          <Tile
            label={format(t.pickup, { days: PICKUP_DAYS })}
            value={signed(otb.sold - week.sold, num) + ` ${t.nightsShort}`}
            sub={signed(otb.revenue - week.revenue, money)}
          />
        </ul>
        <p className="mt-2 text-xs text-stone">{format(t.lyFinalNote, { revenue: money(final.revenue), nights: num(final.sold), occupancy: pct(ratios(final).occupancy) })}</p>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <BarChart
            title={t.otbOccupancyByMonth}
            points={pace.current.series.map((s) => ({ key: s.key, label: monthName(s.key), short: formatDate(`${s.key}-01`, lang, { month: "short" }), value: ratios(s).occupancy }))}
            max={1}
            format={pct}
            tableLabel={t.asTable}
            columnLabel={t.occupancy}
          />
          <BarChart
            title={t.otbRevenueByMonth}
            points={pace.current.series.map((s) => ({ key: s.key, label: monthName(s.key), short: formatDate(`${s.key}-01`, lang, { month: "short" }), value: s.revenue }))}
            format={money}
            tableLabel={t.asTable}
            columnLabel={t.revenue}
          />
        </div>

        <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-white/70">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wider text-stone">
              <tr>
                <th className="px-4 py-2">{t.stayMonth}</th>
                <th className="px-4 py-2 text-right">{t.otbNights}</th>
                <th className="px-4 py-2 text-right">{t.otbRevenue}</th>
                <th className="px-4 py-2 text-right">{t.otbAdr}</th>
                <th className="px-4 py-2 text-right">{format(t.pickup, { days: PICKUP_DAYS })}</th>
                <th className="px-4 py-2 text-right">{t.stly}</th>
                <th className="px-4 py-2 text-right">{t.vsStly}</th>
                <th className="px-4 py-2 text-right">{t.lyFinal}</th>
              </tr>
            </thead>
            <tbody>
              {[...pace.current.series, { key: "total", ...otb }].map((s) => {
                const isTotal = s.key === "total";
                const w = isTotal ? week : find(pace.weekAgo.series, s.key);
                const ly = isTotal ? stly : find(pace.stly.series, lyKey(s.key));
                const fin = isTotal ? final : find(pace.lyFinal.series, lyKey(s.key));
                const r = ratios(s);
                return (
                  <tr key={s.key} className={`border-b border-line/60 last:border-0 ${isTotal ? "font-medium" : ""}`}>
                    <td className="px-4 py-2 text-ink">{isTotal ? t.total : monthName(s.key)}</td>
                    <td className="px-4 py-2 text-right text-ink">
                      {num(s.sold)} / {num(s.available)}
                      <span className="block text-[11px] font-normal text-stone">{pct(r.occupancy)}</span>
                    </td>
                    <td className="px-4 py-2 text-right text-ink">{money(s.revenue)}</td>
                    <td className="px-4 py-2 text-right text-ink">{money(r.adr)}</td>
                    <td className="px-4 py-2 text-right text-ink">
                      {signed(s.sold - (w?.sold ?? 0), num)} {t.nightsShort}
                      <span className="block text-[11px] font-normal text-stone">{signed(s.revenue - (w?.revenue ?? 0), money)}</span>
                    </td>
                    <td className="px-4 py-2 text-right text-ink">
                      {num(ly?.sold ?? 0)} {t.nightsShort}
                      <span className="block text-[11px] font-normal text-stone">{money(ly?.revenue ?? 0)}</span>
                    </td>
                    <td className="px-4 py-2 text-right text-ink">{change(s.revenue, ly?.revenue ?? 0)}</td>
                    <td className="px-4 py-2 text-right text-stone">
                      {num(fin?.sold ?? 0)} {t.nightsShort}
                      <span className="block text-[11px]">{money(fin?.revenue ?? 0)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-stone">{t.paceLimit}</p>
      </section>
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <li className="rounded-xl border border-line bg-white/70 p-4">
      <span className="block text-xs text-stone">{label}</span>
      <span className="mt-1 block break-words font-display text-xl text-ink">{value}</span>
      <span className="mt-1 block text-xs text-stone">{sub}</span>
    </li>
  );
}
