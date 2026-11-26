import { asc, desc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/ops/ops-shell";
import { ReadOnly } from "@/components/ops/read-only";
import { RatesTabs } from "@/components/ops/rates-tabs";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { todayIn } from "@/domain/dates";
import { promoUses } from "@/domain/promos";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { createPromoAction, setPromoActiveAction } from "@/lib/ops/rate-actions";
import { visibleProperties } from "@/lib/ops/queries";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/rates/promos">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).rates.promosTitle };
}

export default async function PromosPage({ params, searchParams }: PageProps<"/[lang]/ops/rates/promos">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
      <Promos lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";

async function Promos({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "rates.view").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const t = dict.rates;
  const sp = await searchParams;
  const properties = (await visibleProperties(staff.actor)).filter((p) => can(staff.actor, "rates.view", p.id).allowed);
  const property = properties.find((p) => p.slug === sp.property) ?? properties[0];
  if (!property) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const canManage = can(staff.actor, "rates.manage", property.id).allowed;
  const db = getDb();
  const types = await db.select({ id: schema.unitTypes.id, name: schema.unitTypes.name }).from(schema.unitTypes).where(eq(schema.unitTypes.propertyId, property.id)).orderBy(asc(schema.unitTypes.sortOrder));
  const promos = await db.select().from(schema.promoCodes).where(eq(schema.promoCodes.propertyId, property.id)).orderBy(desc(schema.promoCodes.isActive), desc(schema.promoCodes.createdAt));
  const uses = await promoUses(db, promos.map((p) => p.id));
  const today = todayIn(property.timezone);
  const day = (d: string) => formatDate(d, lang, { day: "numeric", month: "short", year: "numeric" });
  const window = (from: string | null, until: string | null) => (from && until ? `${day(from)} – ${day(until)}` : from ? format(t.fromDate, { date: day(from) }) : until ? format(t.untilDate, { date: day(until) }) : t.anyDate);
  const done = typeof sp.done === "string" ? t.saved : undefined;
  const error = typeof sp.error === "string" ? ((t.errors as Record<string, string>)[sp.error] ?? t.errors.not_found) : undefined;
  const hidden = (anchor: string) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="property" value={property.slug} />
      <input type="hidden" name="anchor" value={anchor} />
    </>
  );
  const status = (p: (typeof promos)[number]) => {
    if (!p.isActive) return t.promoStatus.off;
    if (p.bookUntil && p.bookUntil < today) return t.promoStatus.ended;
    if (p.maxUses !== null && (uses.get(p.id) ?? 0) >= p.maxUses) return t.promoStatus.usedUp;
    if (p.bookFrom && p.bookFrom > today) return t.promoStatus.scheduled;
    return t.promoStatus.active;
  };

  return (
    <>
      <h1 className="font-display text-3xl text-lagoon">{t.title}</h1>
      <p className="mt-1 max-w-3xl text-sm text-stone">{t.promosIntro}</p>
      <RatesTabs lang={lang} dict={dict} current="promos" property={property.slug} properties={properties} />
      <div className="mt-4 space-y-2">
        {done ? <SuccessNote>{done}</SuccessNote> : null}
        <ErrorNote>{error}</ErrorNote>
      </div>

      <ReadOnly readOnly={!canManage} note={t.readOnly}>
      <section id="promo-list" className="mt-6 scroll-mt-6 rounded-xl border border-line bg-white/70 p-5">
        <h2 className="font-display text-xl text-lagoon">{t.promosTitle}</h2>
        {promos.length ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="text-left text-xs text-stone">
                <tr>
                  <th className="py-1 pr-3 font-normal">{t.promoCode}</th>
                  <th className="py-1 pr-3 font-normal">{t.promoValue}</th>
                  <th className="py-1 pr-3 font-normal">{t.bookWindow}</th>
                  <th className="py-1 pr-3 font-normal">{t.stayWindow}</th>
                  <th className="py-1 pr-3 font-normal">{t.conditions}</th>
                  <th className="py-1 pr-3 font-normal">{t.usesTitle}</th>
                  <th className="py-1 pr-3 font-normal">{t.status}</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line align-top">
                {promos.map((p) => {
                  const typeNames = p.unitTypeIds.map((id) => types.find((x) => x.id === id)?.name ?? "—");
                  return (
                    <tr key={p.id} className={p.isActive ? "text-ink" : "text-stone"}>
                      <td className="py-2 pr-3 font-mono font-medium">
                        {p.code}
                        {p.note ? <span className="block font-sans text-xs font-normal text-stone">{p.note}</span> : null}
                      </td>
                      <td className="py-2 pr-3">{p.kind === "percent" ? `${(p.valueBp ?? 0) / 100}%` : formatMoney(p.amount ?? 0, lang)}</td>
                      <td className="py-2 pr-3">{window(p.bookFrom, p.bookUntil)}</td>
                      <td className="py-2 pr-3">{window(p.stayFrom, p.stayUntil)}</td>
                      <td className="py-2 pr-3 text-xs">
                        {p.minNights ? <span className="block">{format(t.minNightsShort, { count: p.minNights })}</span> : null}
                        <span className="block">{typeNames.length ? typeNames.join(", ") : t.allTypes}</span>
                      </td>
                      <td className="py-2 pr-3">{p.maxUses !== null ? `${uses.get(p.id) ?? 0} / ${p.maxUses}` : String(uses.get(p.id) ?? 0)}</td>
                      <td className="py-2 pr-3">{status(p)}</td>
                      <td className="py-2 text-right">
                        <form action={setPromoActiveAction}>
                          {hidden("promo-list")}
                          <input type="hidden" name="promoId" value={p.id} />
                          <input type="hidden" name="active" value={p.isActive ? "0" : "1"} />
                          <button type="submit" className={`text-xs hover:underline ${p.isActive ? "text-danger" : "text-lagoon"}`}>
                            {p.isActive ? t.deactivate : t.activate}
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-2 text-sm text-stone">{t.noPromos}</p>
        )}
      </section>
      </ReadOnly>

      {canManage ? (
      <section id="new-promo" className="mt-6 scroll-mt-6 rounded-xl border border-line bg-white/70 p-5">
        <h2 className="font-display text-xl text-lagoon">{t.newPromo}</h2>
        <p className="mt-1 text-sm text-stone">{t.newPromoIntro}</p>
        <form action={createPromoAction} className="mt-4 grid gap-3 sm:grid-cols-3">
          {hidden("new-promo")}
          <input type="hidden" name="propertyId" value={property.id} />
          <label className="space-y-1 text-xs text-stone">
            <span>{t.promoCode}</span>
            <input name="code" required minLength={3} maxLength={20} pattern="[A-Za-z0-9]{3,20}" autoComplete="off" placeholder="BALI10" className={`${input} uppercase`} />
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span>{t.promoKind}</span>
            <select name="kind" className={input}>
              <option value="percent">{t.kindPercent}</option>
              <option value="amount">{t.kindAmount}</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span>{t.promoValue}</span>
            <input name="value" required inputMode="decimal" placeholder="10" className={input} />
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span>{t.bookFrom}</span>
            <input type="date" name="bookFrom" defaultValue={today} className={input} />
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span>{t.bookUntil}</span>
            <input type="date" name="bookUntil" className={input} />
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span>{t.maxUses}</span>
            <input name="maxUses" inputMode="numeric" placeholder={t.unlimited} className={input} />
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span>{t.stayFrom}</span>
            <input type="date" name="stayFrom" className={input} />
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span>{t.stayUntil}</span>
            <input type="date" name="stayUntil" className={input} />
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span>{t.minNights}</span>
            <input name="minNights" inputMode="numeric" className={input} />
          </label>
          <fieldset className="space-y-1 text-xs text-stone sm:col-span-3">
            <legend>{t.villaTypes}</legend>
            <div className="flex flex-wrap gap-4 pt-1">
              {types.map((x) => (
                <label key={x.id} className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" name="unitTypeIds" value={x.id} className="h-4 w-4 accent-lagoon" />
                  {x.name}
                </label>
              ))}
            </div>
            <p>{t.villaTypesHint}</p>
          </fieldset>
          <label className="space-y-1 text-xs text-stone sm:col-span-3">
            <span>{t.note}</span>
            <input name="note" maxLength={200} placeholder={t.promoNotePlaceholder} className={input} />
          </label>
          <p className="text-xs text-stone sm:col-span-3">{t.stackRule}</p>
          <div className="sm:col-span-3">
            <button type="submit" className="rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
              {t.createPromo}
            </button>
          </div>
        </form>
      </section>
      ) : null}
    </>
  );
}
