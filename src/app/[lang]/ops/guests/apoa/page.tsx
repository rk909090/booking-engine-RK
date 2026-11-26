import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { GuestsTabs } from "@/components/ops/guests-tabs";
import { NoAccess, OpsNav, OpsShell } from "@/components/ops/ops-shell";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { getDb } from "@/db/client";
import { addDays, isIsoDate, todayIn } from "@/domain/dates";
import { foreignArrivals } from "@/domain/guests";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatDateRange } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { countryOptions } from "@/lib/countries";
import { apoaReportAction } from "@/lib/ops/guest-actions";
import { visibleProperties } from "@/lib/ops/queries";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/guests/apoa">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).guests.apoaTitle };
}

export default async function ApoaPage({ params, searchParams }: PageProps<"/[lang]/ops/guests/apoa">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <OpsShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Apoa lang={lang} dict={dict} searchParams={searchParams} />
      </Suspense>
    </OpsShell>
  );
}

const input = "rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function Apoa({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "guest.apoa").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const t = dict.guests;
  const sp = await searchParams;
  const properties = (await visibleProperties(staff.actor)).filter((p) => can(staff.actor, "guest.apoa", p.id).allowed);
  const property = properties.find((p) => p.slug === one(sp.property)) ?? properties[0];
  if (!property) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const today = todayIn(property.timezone);
  const fromRaw = one(sp.from) ?? "";
  const toRaw = one(sp.to) ?? "";
  // Reports are due within a day of arrival: yesterday and today by default.
  const from = isIsoDate(fromRaw) ? fromRaw : addDays(today, -1);
  const to = isIsoDate(toRaw) && toRaw >= from ? toRaw : from > today ? from : today;
  const rows = await foreignArrivals(getDb(), { propertyId: property.id, from, to });
  const countries = new Map(countryOptions(lang));
  const docTypes = t.docTypes as Record<string, string>;
  const pending = rows.filter((r) => !r.reportedAt);
  const done = one(sp.done) ? t.saved : undefined;
  const errorCode = one(sp.error);
  const error = errorCode ? ((t.errors as Record<string, string>)[errorCode] ?? t.errors.not_found) : undefined;
  const csvHref = `/api/ops/apoa?${new URLSearchParams({ property: property.slug, from, to }).toString()}`;
  const hidden = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="property" value={property.slug} />
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="to" value={to} />
    </>
  );

  return (
    <>
      <OpsNav lang={lang} dict={dict} staff={staff} current="guests" />
      <h1 className="font-display text-3xl text-lagoon">{t.title}</h1>
      <GuestsTabs lang={lang} dict={dict} current="apoa" showApoa />
      <p className="mt-4 max-w-3xl text-sm text-stone">{t.apoaIntro}</p>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-2">
        {properties.length > 1 ? (
          <label className="space-y-1 text-xs text-stone">
            <span className="block">{t.property}</span>
            <select name="property" defaultValue={property.slug} className={input}>
              {properties.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <input type="hidden" name="property" value={property.slug} />
        )}
        <label className="space-y-1 text-xs text-stone">
          <span className="block">{t.arrivalsFrom}</span>
          <input type="date" name="from" defaultValue={from} className={input} />
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span className="block">{t.arrivalsTo}</span>
          <input type="date" name="to" defaultValue={to} className={input} />
        </label>
        <button type="submit" className="rounded-lg border border-lagoon px-4 py-2 text-sm text-lagoon hover:bg-lagoon-soft">
          {t.show}
        </button>
        <a href={csvHref} className="rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
          {t.downloadCsv}
        </a>
      </form>
      <p className="mt-2 text-xs text-stone">{t.csvNote}</p>
      <div className="mt-4 space-y-2">
        {done ? <SuccessNote>{done}</SuccessNote> : null}
        <ErrorNote>{error}</ErrorNote>
      </div>

      <p className="mt-4 text-sm text-ink">{format(t.apoaSummary, { dates: formatDateRange(from, to, lang), count: rows.length, pending: pending.length })}</p>
      {rows.length ? (
        <form action={apoaReportAction} className="mt-3">
          {hidden}
          <input type="hidden" name="reported" value="1" />
          <ul className="divide-y divide-line rounded-xl border border-line bg-white/70">
            {rows.map((r) => (
              <li key={r.reservationId} className="grid gap-3 p-4 sm:grid-cols-[auto_1fr_1.6fr_auto] sm:items-start">
                <input type="checkbox" name="reservationId" value={r.reservationId} disabled={Boolean(r.reportedAt)} defaultChecked={!r.reportedAt && !r.missing} aria-label={r.code} className="mt-1 h-4 w-4 accent-lagoon" />
                <div className="text-sm">
                  <Link href={`/${lang}/ops/reservations/${r.code}`} className="font-mono text-lagoon hover:underline">
                    {r.code}
                  </Link>
                  <p className="text-xs text-stone">
                    {r.unitCode} · {formatDateRange(r.checkIn, r.checkOut, lang)}
                  </p>
                </div>
                <div className="text-sm">
                  {r.missing ? (
                    <p className="text-danger">{t.missingPreCheckin}</p>
                  ) : (
                    <ul className="space-y-1">
                      {r.guests.map((g) => (
                        <li key={g.position}>
                          <span className="font-medium text-ink">{g.fullName}</span>
                          <span className="block text-xs text-stone">
                            {countries.get(g.nationality) ?? g.nationality} · {formatDate(g.birthDate, lang, { day: "numeric", month: "short", year: "numeric" })} · {docTypes[g.documentType ?? ""] ?? "—"}{" "}
                            {g.hasDocument ? `•••• ${g.documentLast4}` : t.documentErased}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="text-right text-xs">
                  {r.reportedAt ? <span className="rounded-full bg-success/10 px-2 py-0.5 font-medium text-success">{t.reported}</span> : <span className="rounded-full bg-terracotta/15 px-2 py-0.5 font-medium text-terracotta-deep">{t.notReported}</span>}
                </div>
              </li>
            ))}
          </ul>
          {pending.length ? (
            <button type="submit" className="mt-3 rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
              {t.markReported}
            </button>
          ) : null}
        </form>
      ) : (
        <p className="mt-3 text-sm text-stone">{t.noForeign}</p>
      )}
    </>
  );
}
