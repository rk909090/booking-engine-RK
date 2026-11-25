import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SearchForm } from "@/components/site/search-form";
import { SiteShell } from "@/components/site/site-shell";
import { VillaImage } from "@/components/site/villa-image";
import { getDb } from "@/db/client";
import { searchAvailability, type SearchResult } from "@/domain/booking";
import { isIsoDate } from "@/domain/dates";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDateRange, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { listProperties } from "@/lib/site/queries";

export async function generateMetadata({ params }: PageProps<"/[lang]/stay">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).results.title };
}

export default async function StayPage({ params, searchParams }: PageProps<"/[lang]/stay">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);

  return (
    <SiteShell lang={lang} dict={dict}>
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <h1 className="font-display text-3xl text-lagoon">{dict.results.title}</h1>
        <Suspense fallback={<p className="mt-6 text-stone">{dict.ops.loading}</p>}>
          <Results lang={lang} dict={dict} searchParams={searchParams} />
        </Suspense>
      </div>
    </SiteShell>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function clampInt(value: string | undefined, min: number, max: number, fallback: number) {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

async function Results({
  lang,
  dict,
  searchParams,
}: {
  lang: Locale;
  dict: Dictionary;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const checkIn = one(sp.checkIn);
  const checkOut = one(sp.checkOut);
  const adults = clampInt(one(sp.adults), 1, 12, 2);
  const children = clampInt(one(sp.children), 0, 12, 0);
  const property = one(sp.property) || undefined;
  const properties = await listProperties();

  const form = (
    <div className="mt-6">
      <SearchForm lang={lang} t={dict.search} properties={properties} values={{ checkIn, checkOut, adults, children, property }} />
    </div>
  );

  if (!checkIn || !checkOut) {
    return (
      <>
        {form}
        <p className="mt-8 text-stone">{dict.results.pickDates}</p>
      </>
    );
  }
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut) || checkOut <= checkIn) {
    return (
      <>
        {form}
        <p role="alert" className="mt-8 text-danger">
          {dict.results.invalidDates}
        </p>
      </>
    );
  }

  const results = await searchAvailability(getDb(), { checkIn, checkOut, adults, children, propertySlug: property });
  const nights = results.find((r) => r.quote.ok)?.quote;
  const nightsCount = nights && nights.ok ? nights.quote.nightsCount : 0;

  return (
    <>
      {form}
      <p className="mt-8 text-sm text-stone">
        {format(dict.results.summary, {
          dates: formatDateRange(checkIn, checkOut, lang),
          nights: format(dict.search.nights, { count: nightsCount }),
          guests: format(dict.search.guests, { count: adults + children }),
        })}
      </p>
      {results.length === 0 ? <p className="mt-6 text-stone">{dict.results.noResults}</p> : null}
      <ul className="mt-6 grid gap-6">
        {results.map((r) => (
          <ResultCard key={r.unitType.id} lang={lang} dict={dict} result={r} query={{ checkIn, checkOut, adults, children }} />
        ))}
      </ul>
    </>
  );
}

function ResultCard({
  lang,
  dict,
  result,
  query,
}: {
  lang: Locale;
  dict: Dictionary;
  result: SearchResult;
  query: { checkIn: string; checkOut: string; adults: number; children: number };
}) {
  const t = dict.results;
  const { unitType, property, quote } = result;
  const qs = new URLSearchParams({
    checkIn: query.checkIn,
    checkOut: query.checkOut,
    adults: String(query.adults),
    children: String(query.children),
  }).toString();
  const villaHref = `/${lang}/villas/${property.slug}/${unitType.slug}?${qs}`;

  let problem: string | null = null;
  if (!result.fitsGuests) problem = format(t.tooManyGuests, { max: unitType.maxGuests });
  else if (!quote.ok) {
    const e = quote.error;
    problem =
      e.kind === "min_stay"
        ? format(t.minStay, { nights: e.minNights })
        : e.kind === "max_stay"
          ? format(t.maxStay, { nights: e.maxNights })
          : e.kind === "check_in_in_past"
            ? t.pastDate
            : t.invalidDates;
  } else if (result.freeUnits === 0) problem = t.soldOut;

  return (
    <li className="grid overflow-hidden rounded-2xl border border-line bg-white/70 sm:grid-cols-[260px_1fr]">
      <VillaImage className="h-44 sm:h-full" palette={unitType.content.palette} />
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-terracotta-deep">{property.name}</p>
          <h2 className="mt-1 font-display text-2xl text-lagoon">
            <Link href={villaHref} className="hover:underline">
              {unitType.name}
            </Link>
          </h2>
          {unitType.content.summary ? <p className="mt-1 text-ink">{unitType.content.summary[lang]}</p> : null}
          <p className="mt-2 text-sm text-stone">
            {format(dict.villa.bedrooms, { count: unitType.bedrooms })} · {format(dict.villa.maxGuests, { count: unitType.maxGuests })}
          </p>
          {!problem && result.freeUnits > 0 ? (
            <p className="mt-2 text-sm text-success">
              {result.freeUnits === 1 ? t.lastOne : format(t.available, { free: result.freeUnits, total: result.totalUnits })}
            </p>
          ) : null}
        </div>
        <div className="flex min-w-48 flex-col items-start gap-2 sm:items-end sm:text-right">
          {problem ? (
            <p className="text-sm text-stone">{problem}</p>
          ) : quote.ok ? (
            <>
              <p className="text-sm text-stone">{format(t.total, { nights: format(dict.search.nights, { count: quote.quote.nightsCount }) })}</p>
              <p className="font-display text-2xl text-lagoon">{formatMoney(quote.quote.total, lang)}</p>
              <p className="text-xs text-stone">
                {format(t.perNight, { amount: formatMoney(Math.round(quote.quote.subtotal / quote.quote.nightsCount), lang) })}
              </p>
              <Link
                href={`/${lang}/book?unitType=${unitType.id}&${qs}`}
                className="mt-1 rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep"
              >
                {t.select}
              </Link>
            </>
          ) : null}
          <Link href={villaHref} className="text-sm text-lagoon underline-offset-4 hover:underline">
            {t.details}
          </Link>
        </div>
      </div>
    </li>
  );
}
