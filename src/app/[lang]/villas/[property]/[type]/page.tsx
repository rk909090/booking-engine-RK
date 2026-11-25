import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SiteShell } from "@/components/site/site-shell";
import { VillaImage } from "@/components/site/villa-image";
import { getDb } from "@/db/client";
import { availabilityCalendar } from "@/domain/booking";
import { isIsoDate, todayIn } from "@/domain/dates";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { getVilla } from "@/lib/site/queries";
import { BookingCalendar } from "./booking-calendar";

type Props = PageProps<"/[lang]/villas/[property]/[type]">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang, property, type } = await params;
  if (!hasLocale(lang)) return {};
  const villa = await getVilla(property, type);
  if (!villa) return {};
  return {
    title: `${villa.type.name} · ${villa.property.name}`,
    description: villa.type.content.summary?.[lang],
  };
}

export default async function VillaPage({ params, searchParams }: Props) {
  const lang = await rootLang();
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <SiteShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="mx-auto max-w-6xl px-4 py-10 text-stone sm:px-6">{dict.ops.loading}</p>}>
        <VillaContent lang={lang} dict={dict} params={params} searchParams={searchParams} />
      </Suspense>
    </SiteShell>
  );
}

function one(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function VillaContent({
  lang,
  dict,
  params,
  searchParams,
}: {
  lang: Locale;
  dict: Dictionary;
  params: Props["params"];
  searchParams: Props["searchParams"];
}) {
  const [{ property, type }, sp] = await Promise.all([params, searchParams]);
  const villa = await getVilla(property, type);
  if (!villa) notFound();
  const t = dict.villa;
  const today = todayIn(villa.property.timezone);
  const days = await availabilityCalendar(getDb(), { unitTypeId: villa.type.id, from: today, days: 180 });
  const lowest = Math.min(villa.type.baseRate, ...villa.seasons.map((s) => s.nightlyRate));
  const checkIn = one(sp.checkIn);
  const checkOut = one(sp.checkOut);

  return (
    <article className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <nav className="text-sm text-stone">
        <Link href={`/${lang}/stay?property=${villa.property.slug}`} className="hover:text-lagoon">
          {villa.property.name}
        </Link>{" "}
        / <span className="text-ink">{villa.type.name}</span>
      </nav>
      <h1 className="mt-3 font-display text-4xl text-lagoon">{villa.type.name}</h1>
      {villa.type.content.summary ? <p className="mt-2 text-lg text-ink">{villa.type.content.summary[lang]}</p> : null}

      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_380px]">
        <div>
          <VillaImage className="h-72 rounded-2xl sm:h-96" palette={villa.type.content.palette} />
          <p className="mt-2 text-xs text-stone">{t.photoNote}</p>
          <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink">
            <li>{format(t.bedrooms, { count: villa.type.bedrooms })}</li>
            <li>{format(t.maxGuests, { count: villa.type.maxGuests })}</li>
            <li>{format(t.minStay, { count: villa.type.minStayNights })}</li>
            <li className="font-medium text-lagoon">{format(t.fromPrice, { amount: formatMoney(lowest, lang) })}</li>
          </ul>
          {villa.type.content.description ? (
            <p className="mt-6 max-w-2xl leading-relaxed text-ink">{villa.type.content.description[lang]}</p>
          ) : null}
          {villa.type.amenities.length ? (
            <section className="mt-8">
              <h2 className="text-sm font-semibold uppercase tracking-[0.15em] text-terracotta-deep">{t.amenitiesTitle}</h2>
              <ul className="mt-3 grid gap-2 text-ink sm:grid-cols-2">
                {villa.type.amenities.map((code) => (
                  <li key={code} className="flex items-center gap-2">
                    <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-terracotta" />
                    {dict.amenities[code as keyof Dictionary["amenities"]] ?? code}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
        <aside aria-labelledby="availability-heading">
          <h2 id="availability-heading" className="mb-3 font-display text-2xl text-lagoon">
            {t.availabilityTitle}
          </h2>
          <BookingCalendar
            lang={lang}
            t={t}
            searchT={dict.search}
            days={days}
            unitTypeId={villa.type.id}
            minStayNights={villa.type.minStayNights}
            maxGuests={villa.type.maxGuests}
            initial={{
              checkIn: checkIn && isIsoDate(checkIn) ? checkIn : undefined,
              checkOut: checkOut && isIsoDate(checkOut) ? checkOut : undefined,
              adults: Math.max(1, Math.min(villa.type.maxGuests, Number(one(sp.adults)) || 2)),
              children: Math.max(0, Number(one(sp.children)) || 0),
            }}
          />
        </aside>
      </div>
    </article>
  );
}
