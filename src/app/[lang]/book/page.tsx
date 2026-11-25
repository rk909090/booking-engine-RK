import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SiteShell } from "@/components/site/site-shell";
import { getDb } from "@/db/client";
import { searchAvailability } from "@/domain/booking";
import { isIsoDate } from "@/domain/dates";
import type { CancellationTier } from "@/domain/types";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatDateRange, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { getUnitTypeById } from "@/lib/site/queries";
import { CheckoutForm } from "./checkout-form";

export async function generateMetadata({ params }: PageProps<"/[lang]/book">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).checkout.title };
}

export default async function BookPage({ params, searchParams }: PageProps<"/[lang]/book">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <SiteShell lang={lang} dict={dict}>
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <h1 className="font-display text-3xl text-lagoon">{dict.checkout.title}</h1>
        <Suspense fallback={<p className="mt-6 text-stone">{dict.ops.loading}</p>}>
          <Checkout lang={lang} dict={dict} searchParams={searchParams} />
        </Suspense>
      </div>
    </SiteShell>
  );
}

function one(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function Checkout({
  lang,
  dict,
  searchParams,
}: {
  lang: Locale;
  dict: Dictionary;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const unitTypeId = one(sp.unitType) ?? "";
  const checkIn = one(sp.checkIn) ?? "";
  const checkOut = one(sp.checkOut) ?? "";
  const adults = Math.max(1, Number(one(sp.adults)) || 2);
  const children = Math.max(0, Number(one(sp.children)) || 0);
  const t = dict.checkout;

  const backToSearch = (message: string) => (
    <div className="mt-6 space-y-4">
      <p role="alert" className="text-danger">
        {message}
      </p>
      <Link href={`/${lang}/stay`} className="text-lagoon underline-offset-4 hover:underline">
        {dict.search.title}
      </Link>
    </div>
  );

  if (!UUID.test(unitTypeId) || !isIsoDate(checkIn) || !isIsoDate(checkOut) || checkOut <= checkIn) {
    return backToSearch(dict.results.invalidDates);
  }
  const unit = await getUnitTypeById(unitTypeId);
  if (!unit) return backToSearch(t.errors.unknown_unit_type);

  const results = await searchAvailability(getDb(), {
    checkIn,
    checkOut,
    adults,
    children,
    propertySlug: unit.property.slug,
  });
  const result = results.find((r) => r.unitType.id === unitTypeId);
  if (!result) return backToSearch(t.errors.unknown_unit_type);
  if (!result.fitsGuests) return backToSearch(t.errors.too_many_guests);
  if (!result.quote.ok) return backToSearch(t.errors.quote);
  if (result.freeUnits === 0) return backToSearch(t.errors.sold_out);

  const q = result.quote.quote;
  const property = result.property;
  const tiers = [...property.cancellationTiers].sort((a, b) => b.minDaysBefore - a.minDaysBefore);

  return (
    <div className="mt-6 grid gap-10 lg:grid-cols-[1fr_380px]">
      <section aria-labelledby="guest-heading">
        <h2 id="guest-heading" className="mb-4 font-display text-xl text-lagoon">
          {t.guestDetails}
        </h2>
        <CheckoutForm
          lang={lang}
          t={t}
          stay={{ unitTypeId, checkIn, checkOut, adults, children }}
          holdMinutes={property.holdMinutes}
        />
      </section>

      <aside className="space-y-6">
        <div className="rounded-2xl border border-line bg-white/80 p-5">
          <h2 className="font-display text-xl text-lagoon">{t.yourStay}</h2>
          <p className="mt-2 font-medium text-ink">
            {result.unitType.name} · {property.name}
          </p>
          <p className="text-sm text-stone">{formatDateRange(checkIn, checkOut, lang)}</p>
          <p className="text-sm text-stone">
            {format(dict.search.nights, { count: q.nightsCount })} · {format(dict.search.guests, { count: adults + children })}
          </p>

          <h3 className="mt-5 text-sm font-semibold uppercase tracking-[0.15em] text-terracotta-deep">{t.priceTitle}</h3>
          <dl className="mt-2 space-y-1 text-sm">
            <Row label={format(t.nightsLine, { nights: format(dict.search.nights, { count: q.nightsCount }), amount: formatMoney(Math.round(q.subtotal / q.nightsCount), lang) })} value={formatMoney(q.subtotal, lang)} />
            {q.service ? <Row label={t.service} value={formatMoney(q.service, lang)} /> : null}
            {q.tax ? <Row label={t.tax} value={formatMoney(q.tax, lang)} /> : null}
            <Row label={t.total} value={formatMoney(q.total, lang)} strong />
            <Row label={t.dueNow} value={formatMoney(q.dueNow, lang)} strong />
          </dl>
          <p className="mt-2 text-xs text-stone">
            {q.payInFull
              ? format(t.payInFull, { days: property.balanceDueDays })
              : `${format(t.depositNote, { percent: property.depositRateBp / 100 })} ${format(t.balance, {
                  amount: formatMoney(q.balance, lang),
                  date: formatDate(q.balanceDueDate!, lang),
                })}`}
          </p>
        </div>

        <div className="rounded-2xl border border-line bg-white/80 p-5">
          <h2 className="font-display text-xl text-lagoon">{t.policyTitle}</h2>
          <PolicyList tiers={tiers} t={t} />
        </div>
      </aside>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? "border-t border-line pt-1 font-medium text-ink" : "text-stone"}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function PolicyList({ tiers, t }: { tiers: CancellationTier[]; t: Dictionary["checkout"] }) {
  return (
    <ul className="mt-2 space-y-1 text-sm text-ink">
      {tiers.map((tier, i) =>
        tier.minDaysBefore > 0 || i < tiers.length - 1 ? (
          <li key={tier.minDaysBefore}>{format(t.policyLine, { days: tier.minDaysBefore, percent: tier.chargeBp / 100 })}</li>
        ) : (
          <li key={tier.minDaysBefore}>
            {format(t.policyLast, { days: tiers[i - 1]?.minDaysBefore ?? 1, percent: tier.chargeBp / 100 })}
          </li>
        ),
      )}
    </ul>
  );
}
