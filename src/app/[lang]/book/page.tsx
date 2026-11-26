import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SiteShell } from "@/components/site/site-shell";
import { getDb } from "@/db/client";
import { searchAvailability } from "@/domain/booking";
import { isIsoDate, todayIn } from "@/domain/dates";
import { availablePlans, quoteStay, type Quote } from "@/domain/pricing";
import { checkPromo, cleanPromoCode } from "@/domain/promos";
import { RATE_PLANS, type CancellationTier, type RatePlan } from "@/domain/types";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatDateRange, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { offerLabel } from "@/lib/pricing-labels";
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

  const property = result.property;
  const p = dict.pricing;
  const today = todayIn(property.timezone);
  // Rate plan and promo code travel in the URL (no personal data), so each choice re-prices on the server.
  const planRaw = one(sp.plan);
  const wantedPlan: RatePlan = (RATE_PLANS as readonly string[]).includes(planRaw ?? "") ? (planRaw as RatePlan) : "standard";
  const promoCode = cleanPromoCode(one(sp.promo) ?? "").slice(0, 20);
  const promoCheck = promoCode
    ? await checkPromo(getDb(), { propertyId: property.id, unitTypeId, code: promoCode, checkIn, checkOut, today, now: new Date() })
    : null;
  const promo = promoCheck?.ok ? promoCheck.promo : null;
  const options = availablePlans(result.rules)
    .map((plan) => ({ plan, priced: quoteStay(result.rules, { checkIn, checkOut, today }, null, { plan, guests: adults + children, promo }) }))
    .flatMap((o) => (o.priced.ok ? [{ plan: o.plan, quote: o.priced.quote }] : []));
  const chosen = options.find((o) => o.plan === wantedPlan) ?? options[0];
  if (!chosen) return backToSearch(t.errors.quote);
  const q: Quote = chosen.quote;
  const href = (changes: { plan?: RatePlan; promo?: string | null }) => {
    const next = new URLSearchParams({ unitType: unitTypeId, checkIn, checkOut, adults: String(adults), children: String(children) });
    const plan = changes.plan ?? chosen.plan;
    if (plan !== "standard") next.set("plan", plan);
    const code = changes.promo === undefined ? (promo ? promo.code : "") : (changes.promo ?? "");
    if (code) next.set("promo", code);
    return `/${lang}/book?${next.toString()}`;
  };
  const planHint = (plan: RatePlan) =>
    plan === "non_refundable"
      ? format(p.planHints.non_refundable, { percent: (property.nonRefundableBp ?? 0) / 100 })
      : plan === "breakfast"
        ? format(p.planHints.breakfast, { amount: formatMoney(property.breakfastPerGuest ?? 0, lang) })
        : p.planHints.standard;
  const tiers = [...property.cancellationTiers].sort((a, b) => b.minDaysBefore - a.minDaysBefore);
  const nonRefundable = q.ratePlan === "non_refundable";

  return (
    <div className="mt-6 grid gap-10 lg:grid-cols-[1fr_380px]">
      <section aria-labelledby="guest-heading" className="space-y-8">
        {options.length > 1 ? (
          <div>
            <h2 className="mb-3 font-display text-xl text-lagoon">{t.planTitle}</h2>
            <ul className="grid gap-3">
              {options.map((o) => {
                const active = o.plan === chosen.plan;
                return (
                  <li key={o.plan}>
                    <Link
                      href={href({ plan: o.plan })}
                      scroll={false}
                      aria-current={active ? "true" : undefined}
                      className={`flex items-start justify-between gap-4 rounded-xl border p-4 ${active ? "border-lagoon bg-lagoon-soft/50 ring-2 ring-lagoon/20" : "border-line bg-white/70 hover:border-lagoon"}`}
                    >
                      <span>
                        <span className="block font-medium text-ink">
                          {p.plans[o.plan]} {active ? <span className="ml-2 rounded-full bg-lagoon px-2 py-0.5 text-xs text-ivory">{t.planChosen}</span> : null}
                        </span>
                        <span className="mt-1 block text-sm text-stone">{planHint(o.plan)}</span>
                      </span>
                      <span className="shrink-0 text-right font-medium text-ink">{formatMoney(o.quote.total, lang)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        <div>
          <h2 className="mb-3 font-display text-xl text-lagoon">{t.promoTitle}</h2>
          <form method="get" action={`/${lang}/book`} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="unitType" value={unitTypeId} />
            <input type="hidden" name="checkIn" value={checkIn} />
            <input type="hidden" name="checkOut" value={checkOut} />
            <input type="hidden" name="adults" value={adults} />
            <input type="hidden" name="children" value={children} />
            {chosen.plan !== "standard" ? <input type="hidden" name="plan" value={chosen.plan} /> : null}
            <label className="space-y-1.5 text-sm font-medium text-ink">
              <span className="block">{t.promoLabel}</span>
              <input
                name="promo"
                defaultValue={promoCode}
                maxLength={20}
                autoComplete="off"
                className="w-48 rounded-lg border border-line bg-white px-3 py-2.5 uppercase text-ink outline-none focus:border-lagoon focus:ring-2 focus:ring-lagoon/20"
              />
            </label>
            <button type="submit" className="rounded-lg border border-lagoon px-4 py-2.5 text-sm font-medium text-lagoon hover:bg-lagoon-soft">
              {t.promoApply}
            </button>
            {promoCode ? (
              <Link href={href({ promo: null })} scroll={false} className="py-2.5 text-sm text-stone underline-offset-4 hover:underline">
                {t.promoRemove}
              </Link>
            ) : null}
          </form>
          {promoCheck && !promoCheck.ok ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {t.promoErrors[promoCheck.error]}
            </p>
          ) : promo && q.promoIgnored ? (
            <p className="mt-2 text-sm text-stone">{format(t.promoIgnored, { code: promo.code, offer: q.offer ? offerLabel(p, q.offer) : p.staffDiscount })}</p>
          ) : promo ? (
            <p className="mt-2 text-sm text-success">{format(t.promoApplied, { code: promo.code })}</p>
          ) : null}
        </div>

        <div>
          <h2 id="guest-heading" className="mb-4 font-display text-xl text-lagoon">
            {t.guestDetails}
          </h2>
          <CheckoutForm
            lang={lang}
            t={t}
            stay={{ unitTypeId, checkIn, checkOut, adults, children, ratePlan: chosen.plan, promo: promo && !q.promoIgnored ? promo.code : "" }}
            holdMinutes={property.holdMinutes}
          />
        </div>
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
          <p className="mt-1 text-sm font-medium text-ink">{p.plans[q.ratePlan]}</p>

          <h3 className="mt-5 text-sm font-semibold uppercase tracking-[0.15em] text-terracotta-deep">{t.priceTitle}</h3>
          <dl className="mt-2 space-y-1 text-sm">
            <Row label={format(t.nightsLine, { nights: format(dict.search.nights, { count: q.nightsCount }), amount: formatMoney(Math.round(q.subtotal / q.nightsCount), lang) })} value={formatMoney(q.subtotal, lang)} />
            {q.planDiscount ? <Row label={p.planDiscount} value={`−${formatMoney(q.planDiscount, lang)}`} /> : null}
            {q.offer ? <Row label={offerLabel(p, q.offer)} value={`−${formatMoney(q.offer.amount, lang)}`} /> : null}
            {q.breakfast ? <Row label={format(p.breakfastLine, { count: q.nightsCount })} value={formatMoney(q.breakfast, lang)} /> : null}
            {q.service ? <Row label={t.service} value={formatMoney(q.service, lang)} /> : null}
            {q.tax ? <Row label={t.tax} value={formatMoney(q.tax, lang)} /> : null}
            <Row label={t.total} value={formatMoney(q.total, lang)} strong />
            <Row label={t.dueNow} value={formatMoney(q.dueNow, lang)} strong />
          </dl>
          <p className="mt-2 text-xs text-stone">
            {nonRefundable
              ? t.nonRefundableNote
              : q.payInFull
                ? format(t.payInFull, { days: property.balanceDueDays })
                : `${format(t.depositNote, { percent: property.depositRateBp / 100 })} ${format(t.balance, {
                    amount: formatMoney(q.balance, lang),
                    date: formatDate(q.balanceDueDate!, lang),
                  })}`}
          </p>
        </div>

        <div className="rounded-2xl border border-line bg-white/80 p-5">
          <h2 className="font-display text-xl text-lagoon">{t.policyTitle}</h2>
          {nonRefundable ? <p className="mt-2 text-sm text-ink">{t.policyNonRefundable}</p> : <PolicyList tiers={tiers} t={t} />}
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
