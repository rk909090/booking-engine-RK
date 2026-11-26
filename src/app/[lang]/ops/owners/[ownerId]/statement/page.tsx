import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { brand } from "@/config/brand";
import { Shell } from "@/components/folio/invoice-document";
import { PrintButton } from "@/components/folio/print-button";
import { getDb } from "@/db/client";
import { todayIn } from "@/domain/dates";
import { buildStatements, monthStart } from "@/domain/owners";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { visibleProperties } from "@/lib/ops/queries";

type Props = PageProps<"/[lang]/ops/owners/[ownerId]/statement">;

export async function generateMetadata(): Promise<Metadata> {
  const lang = await rootLang();
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).owners.statementPageTitle, robots: { index: false } };
}

export default async function OwnerStatementPage({ params, searchParams }: Props) {
  const lang = await rootLang();
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="p-6 text-sm text-stone">{dict.ops.loading}</p>}>
      <Statement lang={lang} dict={dict} params={params} searchParams={searchParams} />
    </Suspense>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function Statement({ lang, dict, params, searchParams }: { lang: Locale; dict: Dictionary; params: Props["params"]; searchParams: Props["searchParams"] }) {
  const staff = await requireStaff(lang);
  const [{ ownerId }, sp] = await Promise.all([params, searchParams]);
  const property = (await visibleProperties(staff.actor)).find((p) => p.slug === sp.property);
  const month = typeof sp.month === "string" ? sp.month : "";
  if (!UUID.test(ownerId) || !property || !monthStart(month) || !can(staff.actor, "owners.view", property.id).allowed) notFound();
  const row = (await buildStatements(getDb(), { propertyId: property.id, month }))?.find((r) => r.ownerId === ownerId);
  if (!row) notFound();
  const t = dict.owners;
  const d = row.data;
  const money = (n: number) => formatMoney(n, lang);
  const day = (x: string) => formatDate(x, lang, { day: "numeric", month: "short" });
  const monthName = formatDate(d.month, lang, { month: "long", year: "numeric" });
  const categories = t.categories as Record<string, string>;
  const sources = dict.resList.sources as Record<string, string>;

  return (
    <Shell
      toolbar={
        <>
          <Link href={`/${lang}/ops/owners?property=${property.slug}&month=${month}`} className="text-sm text-lagoon hover:underline">
            ← {t.backToStatements}
          </Link>
          <span className="flex gap-2">
            <a href={`/api/ops/owners/statement?owner=${ownerId}&property=${property.slug}&month=${month}`} className="rounded-lg border border-lagoon px-4 py-2 text-sm text-lagoon hover:bg-lagoon-soft">
              {dict.reports.xlsx}
            </a>
            <PrintButton label={dict.invoice.print} />
          </span>
        </>
      }
    >
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
        <div className="text-sm text-ink">
          <p className="font-display text-2xl text-lagoon">{brand.name}</p>
          <p>{d.property.name}</p>
        </div>
        <div className="text-right text-sm">
          <p className="font-display text-xl tracking-wide text-ink">{t.statementTitle}</p>
          <p className="text-stone">{monthName}</p>
          <p className={`mt-1 text-xs font-medium ${row.status === "draft" ? "text-terracotta-deep" : "text-success"}`}>
            {row.status === "draft" ? t.draftNotice : t.statusLabels[row.status]}
            {row.status === "paid" && row.paidReference ? ` · ${row.paidReference}` : ""}
          </p>
        </div>
      </header>

      <section className="mt-5 text-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-stone">{t.owner}</p>
        <p className="font-medium text-ink">{d.owner.fullName}</p>
        {d.owner.email ? <p className="text-stone">{d.owner.email}</p> : null}
      </section>

      <section className="mt-6">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-line">
            <Line label={format(t.summaryNights, { sold: d.totals.soldNights, owned: d.totals.ownedNights })} value="" />
            <Line label={t.roomRevenue} value={money(d.totals.roomRevenue)} />
            {d.totals.commission ? <Line label={t.commission} value={`−${money(d.totals.commission)}`} /> : null}
            <Line label={t.fee} value={`−${money(d.totals.fee)}`} />
            {d.totals.expenses ? <Line label={t.expenses} value={`−${money(d.totals.expenses)}`} /> : null}
            <Line label={d.totals.payout < 0 ? t.ownerOwes : t.payout} value={money(Math.abs(d.totals.payout))} strong />
          </tbody>
        </table>
        <p className="mt-2 text-xs text-stone">{t.formula}</p>
      </section>

      {d.units.map((u) => (
        <section key={u.unitId} className="mt-8 break-inside-avoid">
          <h2 className="border-b border-line pb-1 font-display text-lg text-lagoon">
            {u.code} · {u.typeName}
          </h2>
          <p className="mt-1 text-xs text-stone">
            {format(t.unitLine, { sold: u.soldNights, owned: u.ownedNights, occupancy: u.ownedNights ? Math.round((u.soldNights / u.ownedNights) * 100) : 0, fee: u.feeBp / 100 })}
          </p>
          {u.stays.length ? (
            <table className="mt-2 w-full text-xs">
              <thead className="text-left text-stone">
                <tr>
                  <th className="py-1 pr-2 font-normal">{t.booking}</th>
                  <th className="py-1 pr-2 font-normal">{t.stayDates}</th>
                  <th className="py-1 pr-2 font-normal">{t.channel}</th>
                  <th className="py-1 pr-2 text-right font-normal">{t.nightsInMonth}</th>
                  <th className="py-1 pr-2 text-right font-normal">{t.roomRevenue}</th>
                  <th className="py-1 text-right font-normal">{t.commission}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-ink">
                {u.stays.map((s) => (
                  <tr key={s.code}>
                    <td className="py-1 pr-2 font-mono">{s.code}</td>
                    <td className="py-1 pr-2">
                      {day(s.checkIn)} – {day(s.checkOut)}
                    </td>
                    <td className="py-1 pr-2">{sources[s.source] ?? s.source}</td>
                    <td className="py-1 pr-2 text-right">{s.nights}</td>
                    <td className="py-1 pr-2 text-right">{money(s.revenue)}</td>
                    <td className="py-1 text-right">{s.commission ? `−${money(s.commission)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-2 text-xs text-stone">{t.noStays}</p>
          )}
          {u.expenses.length ? (
            <table className="mt-3 w-full text-xs">
              <thead className="text-left text-stone">
                <tr>
                  <th className="py-1 pr-2 font-normal">{t.date}</th>
                  <th className="py-1 pr-2 font-normal">{t.category}</th>
                  <th className="py-1 pr-2 font-normal">{t.description}</th>
                  <th className="py-1 text-right font-normal">{t.amount}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-ink">
                {u.expenses.map((e, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-2">{e.source === "recurring" ? t.monthly : day(e.date)}</td>
                    <td className="py-1 pr-2">{categories[e.category] ?? e.category}</td>
                    <td className="py-1 pr-2">
                      {e.description}
                      {e.source === "maintenance" ? ` (${t.fromMaintenance})` : ""}
                    </td>
                    <td className="py-1 text-right">{money(e.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <table className="mt-3 w-full text-sm">
            <tbody className="divide-y divide-line">
              <Line label={t.roomRevenue} value={money(u.roomRevenue)} />
              {u.commission ? <Line label={t.commission} value={`−${money(u.commission)}`} /> : null}
              <Line label={format(t.feeLine, { percent: u.feeBp / 100 })} value={`−${money(u.fee)}`} />
              {u.expenseTotal ? <Line label={t.expenses} value={`−${money(u.expenseTotal)}`} /> : null}
              <Line label={t.unitPayout} value={money(u.payout)} strong />
            </tbody>
          </table>
        </section>
      ))}
      <p className="mt-8 text-xs text-stone">{format(t.printedOn, { date: formatDate(todayIn(property.timezone), lang) })}</p>
    </Shell>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr className={strong ? "font-medium text-ink" : "text-stone"}>
      <td className="py-1.5 pr-3">{label}</td>
      <td className="py-1.5 text-right">{value}</td>
    </tr>
  );
}
