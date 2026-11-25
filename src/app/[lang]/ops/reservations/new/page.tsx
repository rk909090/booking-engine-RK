import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { NoAccess, OpsNav, OpsShell } from "@/components/ops/ops-shell";
import { getDb } from "@/db/client";
import { searchAvailability } from "@/domain/booking";
import { addDays, diffDays, isIsoDate, todayIn } from "@/domain/dates";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDateRange, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { discountLimitBp } from "@/domain/discount";
import { freeUnitsOfType, visibleProperties } from "@/lib/ops/queries";
import { StaffBookingForm } from "./booking-form";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/reservations/new">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).newBooking.title };
}

export default async function NewBookingPage({ params, searchParams }: PageProps<"/[lang]/ops/reservations/new">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <OpsShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <NewBooking lang={lang} dict={dict} searchParams={searchParams} />
      </Suspense>
    </OpsShell>
  );
}

function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

function count(v: string | undefined, fallback: number, min: number, max: number) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";

async function NewBooking({
  lang,
  dict,
  searchParams,
}: {
  lang: Locale;
  dict: Dictionary;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "reservation.create").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const t = dict.newBooking;
  const r = dict.results;
  const sp = await searchParams;
  const properties = (await visibleProperties(staff.actor)).filter((p) => can(staff.actor, "reservation.create", p.id).allowed);
  const property = properties.find((p) => p.slug === one(sp.property)) ?? properties[0];
  if (!property) return <NoAccess lang={lang} dict={dict} staff={staff} />;

  const now = new Date();
  const today = todayIn(property.timezone, now);
  const checkInRaw = one(sp.checkIn);
  const checkOutRaw = one(sp.checkOut);
  const checkIn = isIsoDate(checkInRaw) ? checkInRaw : today;
  const checkOut = isIsoDate(checkOutRaw) ? checkOutRaw : addDays(checkIn, 1);
  const adults = count(one(sp.adults), 2, 1, 20);
  const children = count(one(sp.children), 0, 0, 20);
  const searched = Boolean(checkInRaw && checkOutRaw);
  const datesValid = checkOut > checkIn;

  const results = searched && datesValid ? await searchAvailability(getDb(), { checkIn, checkOut, adults, children, propertySlug: property.slug, now }) : [];
  const chosen = results.find((x) => x.unitType.id === one(sp.type));
  const bookable = (x: (typeof results)[number]) => x.freeUnits > 0 && x.fitsGuests && x.quote.ok;
  const units = chosen && bookable(chosen) ? await freeUnitsOfType(chosen.unitType.id, checkIn, checkOut, now) : [];
  const nights = datesValid ? diffDays(checkIn, checkOut) : 0;
  const query = (type?: string) =>
    new URLSearchParams({ property: property.slug, checkIn, checkOut, adults: String(adults), children: String(children), ...(type ? { type } : {}) }).toString();

  const why = (x: (typeof results)[number]): string | null => {
    if (!x.quote.ok) {
      const e = x.quote.error;
      return e.kind === "min_stay"
        ? format(r.minStay, { nights: e.minNights })
        : e.kind === "max_stay"
          ? format(r.maxStay, { nights: e.maxNights })
          : e.kind === "check_in_in_past"
            ? r.pastDate
            : r.invalidDates;
    }
    if (!x.fitsGuests) return format(r.tooManyGuests, { max: x.unitType.maxGuests });
    if (x.freeUnits === 0) return r.soldOut;
    return null;
  };

  return (
    <>
      <OpsNav lang={lang} dict={dict} staff={staff} current="reservations" />
      <Link href={`/${lang}/ops/reservations`} className="text-sm text-lagoon hover:underline">
        ← {dict.resDetail.back}
      </Link>
      <h1 className="mt-3 font-display text-3xl text-lagoon">{t.title}</h1>
      <p className="mt-1 max-w-2xl text-sm text-stone">{t.intro}</p>

      <form method="get" className="mt-5 grid gap-3 rounded-xl border border-line bg-white/70 p-4 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_0.6fr_0.6fr_auto] lg:items-end">
        <label className="space-y-1 text-xs text-stone">
          <span>{t.property}</span>
          <select name="property" defaultValue={property.slug} className={input}>
            {properties.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{dict.search.checkIn}</span>
          <input type="date" name="checkIn" required min={today} defaultValue={checkIn} className={input} />
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{dict.search.checkOut}</span>
          <input type="date" name="checkOut" required min={addDays(today, 1)} defaultValue={checkOut} className={input} />
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{dict.search.adults}</span>
          <input type="number" name="adults" min={1} max={20} defaultValue={adults} className={input} />
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{dict.search.children}</span>
          <input type="number" name="children" min={0} max={20} defaultValue={children} className={input} />
        </label>
        <button type="submit" className="rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
          {t.search}
        </button>
      </form>

      {searched && !datesValid ? <p className="mt-4 text-sm text-danger">{r.invalidDates}</p> : null}

      {results.length > 0 ? (
        <section className="mt-6">
          <h2 className="font-display text-xl text-lagoon">{t.typesTitle}</h2>
          <p className="mt-1 text-sm text-stone">
            {format(r.summary, {
              dates: formatDateRange(checkIn, checkOut, lang),
              nights: format(dict.search.nights, { count: nights }),
              guests: format(dict.search.guests, { count: adults + children }),
            })}
          </p>
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-white/70">
            {results.map((x) => {
              const reason = why(x);
              const isChosen = chosen?.unitType.id === x.unitType.id;
              return (
                <li key={x.unitType.id} className={`flex flex-wrap items-center justify-between gap-3 p-4 ${isChosen ? "bg-lagoon-soft/50" : ""}`}>
                  <div>
                    <p className="font-medium text-ink">{x.unitType.name}</p>
                    <p className="text-xs text-stone">
                      {format(r.available, { free: x.freeUnits, total: x.totalUnits })} · {format(r.tooManyGuests, { max: x.unitType.maxGuests })}
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    {x.quote.ok ? (
                      <div className="text-right text-sm">
                        <p className="font-medium text-ink">{formatMoney(x.quote.quote.total, lang)}</p>
                        <p className="text-xs text-stone">
                          {format(x.quote.quote.payInFull ? t.dueNowFull : t.dueNowDeposit, { amount: formatMoney(x.quote.quote.dueNow, lang) })}
                        </p>
                      </div>
                    ) : null}
                    {reason ? (
                      <span className="text-xs text-danger">{reason}</span>
                    ) : isChosen ? (
                      <span className="rounded-lg bg-lagoon px-3 py-1.5 text-sm text-ivory">{t.chosen}</span>
                    ) : (
                      <Link href={`/${lang}/ops/reservations/new?${query(x.unitType.id)}`} className="rounded-lg border border-lagoon px-3 py-1.5 text-sm text-lagoon hover:bg-lagoon-soft">
                        {t.choose}
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {chosen && bookable(chosen) && chosen.quote.ok ? (
        <section className="mt-6 max-w-3xl rounded-xl border border-line bg-white/70 p-5">
          <h2 className="mb-4 font-display text-xl text-lagoon">
            {t.formTitle} · {chosen.unitType.name}
          </h2>
          <StaffBookingForm
            key={query(chosen.unitType.id)}
            lang={lang}
            dict={{ newBooking: t, methods: dict.resDetail.methods, sources: dict.resList.sources }}
            stay={{ unitTypeId: chosen.unitType.id, checkIn, checkOut, adults, children }}
            units={units}
            quote={{
              subtotal: chosen.quote.quote.subtotal,
              total: chosen.quote.quote.total,
              dueNow: chosen.quote.quote.dueNow,
              serviceRateBp: chosen.quote.quote.serviceRateBp,
              taxRateBp: chosen.quote.quote.taxRateBp,
              depositRateBp: chosen.property.depositRateBp,
              payInFull: chosen.quote.quote.payInFull,
            }}
            limitBp={can(staff.actor, "reservation.discount", property.id).allowed ? discountLimitBp(property, staff.actor.role) : 0}
          />
        </section>
      ) : null}
    </>
  );
}
