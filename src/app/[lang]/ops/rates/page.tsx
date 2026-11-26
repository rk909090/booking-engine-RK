import { asc, eq, inArray } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { NoAccess, OpsNav, OpsShell } from "@/components/ops/ops-shell";
import { RatesTabs } from "@/components/ops/rates-tabs";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { addDays, todayIn } from "@/domain/dates";
import { MAX_LONG_STAY_TIERS } from "@/domain/rates";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import {
  addClosureAction,
  addSeasonAction,
  removeClosureAction,
  removeSeasonAction,
  updateOffersAction,
  updateTypeRatesAction,
} from "@/lib/ops/rate-actions";
import { visibleProperties } from "@/lib/ops/queries";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/rates">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).rates.title };
}

export default async function RatesPage({ params, searchParams }: PageProps<"/[lang]/ops/rates">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <OpsShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Rates lang={lang} dict={dict} searchParams={searchParams} />
      </Suspense>
    </OpsShell>
  );
}

const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";
const button = "rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep";
const pct = (bp: number | null | undefined) => (bp ? String(bp / 100) : "");

async function Rates({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "rates.manage").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const t = dict.rates;
  const sp = await searchParams;
  const properties = (await visibleProperties(staff.actor)).filter((p) => can(staff.actor, "rates.manage", p.id).allowed);
  const chosen = properties.find((p) => p.slug === sp.property) ?? properties[0];
  if (!chosen) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const db = getDb();
  const [property] = await db.select().from(schema.properties).where(eq(schema.properties.id, chosen.id));
  const types = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.propertyId, property.id)).orderBy(asc(schema.unitTypes.sortOrder));
  const seasons = types.length
    ? await db.select().from(schema.rateSeasons).where(inArray(schema.rateSeasons.unitTypeId, types.map((x) => x.id))).orderBy(asc(schema.rateSeasons.startDate))
    : [];
  const closures = await db.select().from(schema.arrivalClosures).where(eq(schema.arrivalClosures.propertyId, property.id)).orderBy(asc(schema.arrivalClosures.startDate));
  const today = todayIn(property.timezone);
  const money = (n: number) => formatMoney(n, lang);
  const day = (d: string) => formatDate(d, lang, { day: "numeric", month: "short", year: "numeric" });
  /** [start, end) shown as the first and last date included. */
  const span = (start: string, end: string) => `${day(start)} – ${day(addDays(end, -1))}`;
  const done = typeof sp.done === "string" ? t.saved : undefined;
  const error = typeof sp.error === "string" ? ((t.errors as Record<string, string>)[sp.error] ?? t.errors.not_found) : undefined;
  const hidden = (anchor: string) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="property" value={property.slug} />
      <input type="hidden" name="anchor" value={anchor} />
    </>
  );
  const tiers = Array.from({ length: MAX_LONG_STAY_TIERS }, (_, i) => property.longStayTiers[i] ?? null);

  return (
    <>
      <OpsNav lang={lang} dict={dict} staff={staff} current="rates" />
      <h1 className="font-display text-3xl text-lagoon">{t.title}</h1>
      <p className="mt-1 max-w-3xl text-sm text-stone">{t.intro}</p>
      <RatesTabs lang={lang} dict={dict} current="rates" property={property.slug} properties={properties} />
      <div className="mt-4 space-y-2">
        {done ? <SuccessNote>{done}</SuccessNote> : null}
        <ErrorNote>{error}</ErrorNote>
      </div>

      <Section id="offers" title={t.offersTitle} intro={t.offersIntro}>
        <form action={updateOffersAction} className="space-y-4">
          {hidden("offers")}
          <input type="hidden" name="propertyId" value={property.id} />
          <div className="grid gap-4 lg:grid-cols-3">
            <fieldset className="space-y-2 rounded-xl border border-line p-4">
              <label className="flex items-center gap-2 text-sm font-medium text-ink">
                <input type="checkbox" name="nonRefundableOn" defaultChecked={property.nonRefundableBp !== null} className="h-4 w-4 accent-lagoon" />
                {dict.pricing.plans.non_refundable}
              </label>
              <label className="block space-y-1 text-xs text-stone">
                <span>{t.nonRefundablePercent}</span>
                <input name="nonRefundablePercent" inputMode="decimal" defaultValue={pct(property.nonRefundableBp) || "10"} className={input} />
              </label>
              <p className="text-xs text-stone">{t.nonRefundableHint}</p>
            </fieldset>
            <fieldset className="space-y-2 rounded-xl border border-line p-4">
              <label className="flex items-center gap-2 text-sm font-medium text-ink">
                <input type="checkbox" name="breakfastOn" defaultChecked={property.breakfastPerGuest !== null} className="h-4 w-4 accent-lagoon" />
                {dict.pricing.plans.breakfast}
              </label>
              <label className="block space-y-1 text-xs text-stone">
                <span>{t.breakfastPrice}</span>
                <input name="breakfastPrice" inputMode="numeric" defaultValue={property.breakfastPerGuest ?? ""} className={input} />
              </label>
              <p className="text-xs text-stone">{t.breakfastHint}</p>
            </fieldset>
            <fieldset className="space-y-2 rounded-xl border border-line p-4">
              <label className="flex items-center gap-2 text-sm font-medium text-ink">
                <input type="checkbox" name="earlyBirdOn" defaultChecked={property.earlyBirdDays !== null} className="h-4 w-4 accent-lagoon" />
                {dict.pricing.offers.early_bird}
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1 text-xs text-stone">
                  <span>{t.earlyBirdDays}</span>
                  <input name="earlyBirdDays" inputMode="numeric" defaultValue={property.earlyBirdDays ?? "60"} className={input} />
                </label>
                <label className="block space-y-1 text-xs text-stone">
                  <span>{t.percent}</span>
                  <input name="earlyBirdPercent" inputMode="decimal" defaultValue={pct(property.earlyBirdBp) || "10"} className={input} />
                </label>
              </div>
            </fieldset>
          </div>
          <fieldset className="rounded-xl border border-line p-4">
            <legend className="px-1 text-sm font-medium text-ink">{dict.pricing.offers.long_stay}</legend>
            <p className="mb-3 text-xs text-stone">{t.longStayHint}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {tiers.map((tier, i) => (
                <div key={i} className="grid grid-cols-2 gap-2">
                  <label className="block space-y-1 text-xs text-stone">
                    <span>{t.tierNights}</span>
                    <input name={`tierNights${i + 1}`} inputMode="numeric" defaultValue={tier?.minNights ?? ""} className={input} />
                  </label>
                  <label className="block space-y-1 text-xs text-stone">
                    <span>{t.percent}</span>
                    <input name={`tierPercent${i + 1}`} inputMode="decimal" defaultValue={pct(tier?.bp)} className={input} />
                  </label>
                </div>
              ))}
            </div>
          </fieldset>
          <p className="text-xs text-stone">{t.stackRule}</p>
          <button type="submit" className={button}>
            {t.saveOffers}
          </button>
        </form>
      </Section>

      {types.map((type) => {
        const own = seasons.filter((s) => s.unitTypeId === type.id);
        const anchor = `type-${type.slug}`;
        return (
          <Section key={type.id} id={anchor} title={type.name} intro={format(t.typeIntro, { base: money(type.baseRate), weekend: type.weekendRate ? money(type.weekendRate) : t.sameAsBase })}>
            <form action={updateTypeRatesAction} className="grid gap-3 sm:grid-cols-[1fr_1fr_0.7fr_0.7fr_auto] sm:items-end">
              {hidden(anchor)}
              <input type="hidden" name="unitTypeId" value={type.id} />
              <label className="space-y-1 text-xs text-stone">
                <span>{t.baseRate}</span>
                <input name="baseRate" inputMode="numeric" required defaultValue={type.baseRate} className={input} />
              </label>
              <label className="space-y-1 text-xs text-stone">
                <span>{t.weekendRate}</span>
                <input name="weekendRate" inputMode="numeric" defaultValue={type.weekendRate ?? ""} placeholder={t.sameAsBase} className={input} />
              </label>
              <label className="space-y-1 text-xs text-stone">
                <span>{t.minStay}</span>
                <input name="minStay" inputMode="numeric" required defaultValue={type.minStayNights} className={input} />
              </label>
              <label className="space-y-1 text-xs text-stone">
                <span>{t.maxStay}</span>
                <input name="maxStay" inputMode="numeric" required defaultValue={type.maxStayNights} className={input} />
              </label>
              <button type="submit" className={button}>
                {t.save}
              </button>
            </form>

            <h3 className="mt-5 text-sm font-semibold text-ink">{t.seasonsTitle}</h3>
            {own.length ? (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-left text-xs text-stone">
                    <tr>
                      <th className="py-1 pr-3 font-normal">{t.seasonName}</th>
                      <th className="py-1 pr-3 font-normal">{t.seasonDates}</th>
                      <th className="py-1 pr-3 text-right font-normal">{t.nightlyRate}</th>
                      <th className="py-1 pr-3 text-right font-normal">{t.weekendRate}</th>
                      <th className="py-1 pr-3 text-right font-normal">{t.minStay}</th>
                      <th className="py-1" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {own.map((s) => (
                      <tr key={s.id} className={s.endDate <= today ? "text-stone" : "text-ink"}>
                        <td className="py-2 pr-3">{s.name}</td>
                        <td className="py-2 pr-3">{span(s.startDate, s.endDate)}</td>
                        <td className="py-2 pr-3 text-right">{money(s.nightlyRate)}</td>
                        <td className="py-2 pr-3 text-right">{s.weekendRate ? money(s.weekendRate) : "—"}</td>
                        <td className="py-2 pr-3 text-right">{s.minStayNights ?? "—"}</td>
                        <td className="py-2 text-right">
                          <form action={removeSeasonAction}>
                            {hidden(anchor)}
                            <input type="hidden" name="seasonId" value={s.id} />
                            <button type="submit" className="text-xs text-danger hover:underline">
                              {t.remove}
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-1 text-sm text-stone">{t.noSeasons}</p>
            )}
            <details className="mt-3 rounded-xl border border-line bg-white/60 p-4">
              <summary className="cursor-pointer text-sm font-medium text-lagoon">{t.addSeason}</summary>
              <form action={addSeasonAction} className="mt-3 grid gap-3 sm:grid-cols-3">
                {hidden(anchor)}
                <input type="hidden" name="unitTypeId" value={type.id} />
                <label className="space-y-1 text-xs text-stone">
                  <span>{t.seasonName}</span>
                  <input name="name" required maxLength={60} placeholder={t.seasonNamePlaceholder} className={input} />
                </label>
                <label className="space-y-1 text-xs text-stone">
                  <span>{t.from}</span>
                  <input type="date" name="startDate" required className={input} />
                </label>
                <label className="space-y-1 text-xs text-stone">
                  <span>{t.untilExclusive}</span>
                  <input type="date" name="endDate" required className={input} />
                </label>
                <label className="space-y-1 text-xs text-stone">
                  <span>{t.nightlyRate}</span>
                  <input name="nightlyRate" inputMode="numeric" required className={input} />
                </label>
                <label className="space-y-1 text-xs text-stone">
                  <span>{t.weekendRate}</span>
                  <input name="weekendRate" inputMode="numeric" placeholder={t.sameAsNightly} className={input} />
                </label>
                <label className="space-y-1 text-xs text-stone">
                  <span>{t.minStaySeason}</span>
                  <input name="minStay" inputMode="numeric" placeholder={String(type.minStayNights)} className={input} />
                </label>
                <div className="sm:col-span-3">
                  <button type="submit" className={button}>
                    {t.addSeason}
                  </button>
                </div>
              </form>
            </details>
          </Section>
        );
      })}

      <Section id="closures" title={t.closuresTitle} intro={t.closuresIntro}>
        {closures.length ? (
          <ul className="divide-y divide-line text-sm">
            {closures.map((c) => (
              <li key={c.id} className={`flex flex-wrap items-center justify-between gap-3 py-2 ${c.endDate <= today ? "text-stone" : "text-ink"}`}>
                <span>
                  {span(c.startDate, c.endDate)} · {c.unitTypeId ? (types.find((x) => x.id === c.unitTypeId)?.name ?? "—") : t.allTypes}
                  {c.note ? ` · ${c.note}` : ""}
                </span>
                <form action={removeClosureAction}>
                  {hidden("closures")}
                  <input type="hidden" name="closureId" value={c.id} />
                  <button type="submit" className="text-xs text-danger hover:underline">
                    {t.reopen}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-stone">{t.noClosures}</p>
        )}
        <form action={addClosureAction} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_1fr_1.5fr_auto] sm:items-end">
          {hidden("closures")}
          <input type="hidden" name="propertyId" value={property.id} />
          <label className="space-y-1 text-xs text-stone">
            <span>{t.villaType}</span>
            <select name="unitTypeId" className={input}>
              <option value="">{t.allTypes}</option>
              {types.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span>{t.from}</span>
            <input type="date" name="startDate" required min={today} className={input} />
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span>{t.untilExclusive}</span>
            <input type="date" name="endDate" required min={addDays(today, 1)} className={input} />
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span>{t.note}</span>
            <input name="note" maxLength={200} placeholder={t.closureNotePlaceholder} className={input} />
          </label>
          <button type="submit" className={button}>
            {t.closeArrivals}
          </button>
        </form>
      </Section>
    </>
  );
}

function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section id={id} className="mt-6 scroll-mt-6 rounded-xl border border-line bg-white/70 p-5">
      <h2 className="font-display text-xl text-lagoon">{title}</h2>
      {intro ? <p className="mt-1 text-sm text-stone">{intro}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}
