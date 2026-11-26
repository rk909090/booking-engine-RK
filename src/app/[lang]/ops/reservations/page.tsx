import { GuestBadges } from "@/components/ops/guest-badges";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { OpsNav, OpsShell, StatusBadge, NoAccess } from "@/components/ops/ops-shell";
import { brand } from "@/config/brand";
import { todayIn } from "@/domain/dates";
import { guaranteeDue } from "@/domain/guarantee";
import * as schema from "@/db/schema";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDateRange, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { listReservations } from "@/lib/ops/queries";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/reservations">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).resList.title };
}

export default async function ReservationsPage({ params, searchParams }: PageProps<"/[lang]/ops/reservations">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <OpsShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <ReservationList lang={lang} dict={dict} searchParams={searchParams} />
      </Suspense>
    </OpsShell>
  );
}

function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

const input = "rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";

async function ReservationList({
  lang,
  dict,
  searchParams,
}: {
  lang: Locale;
  dict: Dictionary;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "reservation.view").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const sp = await searchParams;
  const t = dict.resList;
  const today = todayIn(brand.timezone);
  const data = await listReservations(staff.actor, {
    deposit: one(sp.deposit),
    requests: one(sp.requests),
    today,
    q: one(sp.q),
    status: one(sp.status),
    property: one(sp.property),
    from: one(sp.from),
    to: one(sp.to),
    departOn: one(sp.departOn),
    refund: one(sp.refund),
    page: Number(one(sp.page)) || 1,
  });
  const exportHref = `/api/ops/reservations/export?${new URLSearchParams({ ...(Object.fromEntries(Object.entries(data.applied).filter(([, v]) => v)) as Record<string, string>), ...(one(sp.deposit) ? { deposit: one(sp.deposit)! } : {}), ...(one(sp.requests) ? { requests: one(sp.requests)! } : {}), today })}`;
  const pageHref = (page: number) => {
    const qs = new URLSearchParams(Object.entries(data.applied).filter(([, v]) => v) as [string, string][]);
    qs.set("page", String(page));
    return `/${lang}/ops/reservations?${qs}`;
  };

  return (
    <>
      <OpsNav lang={lang} dict={dict} staff={staff} current="reservations" />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl text-lagoon">{t.title}</h1>
          <p className="mt-1 text-sm text-stone">{t.intro}</p>
        </div>
        <a href={exportHref} className="rounded-lg border border-lagoon px-3 py-1.5 text-sm text-lagoon hover:bg-lagoon-soft">
          {dict.reports.xlsx}
        </a>
        {can(staff.actor, "reservation.create").allowed ? (
          <Link href={`/${lang}/ops/reservations/new`} className="rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
            + {dict.opsNav.newBooking}
          </Link>
        ) : null}
      </div>

      <form method="get" className="mt-5 grid gap-3 rounded-xl border border-line bg-white/70 p-4 md:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto] md:items-end">
        {data.applied.departOn ? <input type="hidden" name="departOn" value={data.applied.departOn} /> : null}
        {data.applied.refund ? <input type="hidden" name="refund" value={data.applied.refund} /> : null}
        {data.applied.deposit ? <input type="hidden" name="deposit" value={data.applied.deposit} /> : null}
        {data.applied.requests ? <input type="hidden" name="requests" value={data.applied.requests} /> : null}
        <label className="space-y-1 text-xs text-stone">
          <span>{t.search}</span>
          <input name="q" defaultValue={data.applied.q} className={`w-full ${input}`} maxLength={100} />
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{t.status}</span>
          <select name="status" defaultValue={data.applied.status} className={`w-full ${input}`}>
            <option value="">{t.allStatuses}</option>
            {schema.reservationStatus.enumValues.map((s) => (
              <option key={s} value={s}>
                {dict.booking.status[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{t.property}</span>
          <select name="property" defaultValue={data.applied.property} className={`w-full ${input}`}>
            <option value="">{t.allProperties}</option>
            {data.properties.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{t.arrivalFrom}</span>
          <input type="date" name="from" defaultValue={data.applied.from} className={`w-full ${input}`} />
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{t.arrivalTo}</span>
          <input type="date" name="to" defaultValue={data.applied.to} className={`w-full ${input}`} />
        </label>
        <div className="flex gap-2">
          <button type="submit" className="rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
            {t.apply}
          </button>
          <Link href={`/${lang}/ops/reservations`} className="rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-sand">
            {t.reset}
          </Link>
        </div>
      </form>

      <p className="mt-4 text-sm text-stone">{format(t.count, { shown: data.rows.length, total: data.total })}</p>

      {data.rows.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-line p-6 text-center text-stone">{t.empty}</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-line bg-white/70">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wider text-stone">
              <tr>
                <th className="px-4 py-3">{t.code}</th>
                <th className="px-4 py-3">{t.guest}</th>
                <th className="px-4 py-3">{t.villa}</th>
                <th className="px-4 py-3">{t.stay}</th>
                <th className="px-4 py-3">{t.status}</th>
                <th className="px-4 py-3 text-right">{t.total}</th>
                <th className="px-4 py-3 text-right">{t.paid}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const deposit = guaranteeDue(r, today);
                return (
                <tr key={r.id} className="border-b border-line/60 last:border-0 hover:bg-sand/40">
                  <td className="px-4 py-3 font-mono">
                    <Link href={`/${lang}/ops/reservations/${r.code}`} className="text-lagoon underline-offset-4 hover:underline">
                      {r.code}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-ink">
                    {r.guestName} <GuestBadges dict={dict} tags={r.guestTags} pastStays={r.guestPastStays} />
                    <span className="block text-xs text-stone">{t.sources[r.source]}</span>
                  </td>
                  <td className="px-4 py-3 text-ink">
                    {r.typeName}
                    <span className="block text-xs text-stone">
                      {r.unitCode} · {r.propertyName}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-ink">{formatDateRange(r.checkIn, r.checkOut, lang)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} label={dict.booking.status[r.status]} />
                    {r.refundOutstanding > 0 ? <span className="mt-1 block text-xs text-danger">{t.refundDue}</span> : null}
                    {r.requestPending ? <span className="mt-1 block text-xs text-terracotta-deep">{t.requestPending}</span> : null}
                    {r.preCheckinDone && (r.status === "confirmed" || r.status === "in_house") ? <span className="mt-1 block text-xs text-lagoon">{t.preCheckinDone}</span> : null}
                    {deposit ? (
                      <span className={`mt-1 block text-xs ${deposit.overdue ? "text-danger" : "text-terracotta-deep"}`}>
                        {deposit.overdue ? t.depositOverdue : t.depositOpen}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right text-ink">{formatMoney(r.totalAmount, lang)}</td>
                  <td className="px-4 py-3 text-right text-ink">{formatMoney(r.amountPaid, lang)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data.pages > 1 ? (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label={t.page}>
          {data.page > 1 ? <Link href={pageHref(data.page - 1)} className="text-lagoon hover:underline">← {t.prev}</Link> : <span />}
          <span className="text-stone">{format(t.page, { page: data.page, pages: data.pages })}</span>
          {data.page < data.pages ? <Link href={pageHref(data.page + 1)} className="text-lagoon hover:underline">{t.next} →</Link> : <span />}
        </nav>
      ) : null}
    </>
  );
}
