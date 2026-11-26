import { asc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { NoAccess, OpsNav, OpsShell } from "@/components/ops/ops-shell";
import { RatesTabs } from "@/components/ops/rates-tabs";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { ADDON_PRICING } from "@/domain/addons";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { createAddonAction, updateAddonAction } from "@/lib/ops/rate-actions";
import { visibleProperties } from "@/lib/ops/queries";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/rates/addons">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).rates.tabAddons };
}

export default async function AddonsCatalogPage({ params, searchParams }: PageProps<"/[lang]/ops/rates/addons">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <OpsShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Catalog lang={lang} dict={dict} searchParams={searchParams} />
      </Suspense>
    </OpsShell>
  );
}

const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";

async function Catalog({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "rates.manage").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const t = dict.addons;
  const sp = await searchParams;
  const properties = (await visibleProperties(staff.actor)).filter((p) => can(staff.actor, "rates.manage", p.id).allowed);
  const property = properties.find((p) => p.slug === sp.property) ?? properties[0];
  if (!property) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const addons = await getDb().select().from(schema.addons).where(eq(schema.addons.propertyId, property.id)).orderBy(asc(schema.addons.sortOrder), asc(schema.addons.createdAt));
  const categories = dict.folio.categories as Record<string, string>;
  const done = typeof sp.done === "string" ? dict.rates.saved : undefined;
  const error = typeof sp.error === "string" ? ((t.catalogErrors as Record<string, string>)[sp.error] ?? t.catalogErrors.not_found) : undefined;
  const hidden = (anchor: string) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="property" value={property.slug} />
      <input type="hidden" name="anchor" value={anchor} />
      <input type="hidden" name="propertyId" value={property.id} />
    </>
  );
  const fields = (a?: (typeof addons)[number]) => (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-stone">
          <span>{t.nameId}</span>
          <input name="nameId" required maxLength={80} defaultValue={a?.name.id ?? ""} placeholder="Makan malam private chef" className={input} />
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{t.nameEn}</span>
          <input name="nameEn" required maxLength={80} defaultValue={a?.name.en ?? ""} placeholder="Private chef dinner" className={input} />
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{t.descId}</span>
          <input name="descId" maxLength={500} defaultValue={a?.description?.id ?? ""} className={input} />
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{t.descEn}</span>
          <input name="descEn" maxLength={500} defaultValue={a?.description?.en ?? ""} className={input} />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-5">
        <label className="space-y-1 text-xs text-stone">
          <span>{t.category}</span>
          <select name="category" defaultValue={a?.category ?? "food_beverage"} className={input}>
            {schema.folioCategories.map((c) => (
              <option key={c} value={c}>
                {categories[c] ?? c}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{t.pricingLabel}</span>
          <select name="pricing" defaultValue={a?.pricing ?? "per_person"} className={input}>
            {ADDON_PRICING.map((p) => (
              <option key={p} value={p}>
                {(t.pricingNames as Record<string, string>)[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{t.priceLabel}</span>
          <input name="price" required inputMode="numeric" defaultValue={a?.price ?? ""} className={input} />
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{t.leadHoursLabel}</span>
          <input name="leadHours" inputMode="numeric" defaultValue={a?.leadHours ?? 24} className={input} />
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span>{t.sortOrder}</span>
          <input name="sortOrder" inputMode="numeric" defaultValue={a?.sortOrder ?? addons.length + 1} className={input} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" name="needsTime" defaultChecked={a?.needsTime ?? true} className="h-4 w-4 accent-lagoon" />
        {t.needsTime}
      </label>
    </>
  );

  return (
    <>
      <OpsNav lang={lang} dict={dict} staff={staff} current="rates" />
      <h1 className="font-display text-3xl text-lagoon">{dict.rates.title}</h1>
      <p className="mt-1 max-w-3xl text-sm text-stone">{t.catalogIntro}</p>
      <RatesTabs lang={lang} dict={dict} current="addons" property={property.slug} properties={properties} />
      <div className="mt-4 space-y-2">
        {done ? <SuccessNote>{done}</SuccessNote> : null}
        <ErrorNote>{error}</ErrorNote>
      </div>

      <section id="catalog" className="mt-6 scroll-mt-6 rounded-xl border border-line bg-white/70 p-5">
        <h2 className="font-display text-xl text-lagoon">{t.catalogTitle}</h2>
        {addons.length ? (
          <ul className="mt-3 divide-y divide-line">
            {addons.map((a) => (
              <li key={a.id} className="py-3">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-sm">
                    <span className={a.isActive ? "font-medium text-ink" : "text-stone line-through"}>
                      {a.name[lang] || a.name.id} <span className="text-xs font-normal text-stone">· {categories[a.category] ?? a.category}</span>
                    </span>
                    <span className="text-stone">
                      {format((t.pricing as Record<string, string>)[a.pricing], { price: formatMoney(a.price, lang) })}
                      {a.isActive ? "" : ` · ${t.off}`}
                    </span>
                  </summary>
                  <form action={updateAddonAction} className="mt-3 space-y-3 rounded-lg border border-line bg-white p-4">
                    {hidden(`catalog`)}
                    <input type="hidden" name="addonId" value={a.id} />
                    {fields(a)}
                    <label className="flex items-center gap-2 text-sm text-ink">
                      <input type="checkbox" name="isActive" defaultChecked={a.isActive} className="h-4 w-4 accent-lagoon" />
                      {t.active}
                    </label>
                    <button type="submit" className="rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
                      {dict.rates.save}
                    </button>
                  </form>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-stone">{t.noAddons}</p>
        )}
      </section>

      <section id="new-addon" className="mt-6 scroll-mt-6 rounded-xl border border-line bg-white/70 p-5">
        <h2 className="font-display text-xl text-lagoon">{t.newAddon}</h2>
        <p className="mt-1 text-sm text-stone">{t.newAddonIntro}</p>
        <form action={createAddonAction} className="mt-4 space-y-3">
          {hidden("new-addon")}
          {fields()}
          <button type="submit" className="rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
            {t.create}
          </button>
        </form>
      </section>
    </>
  );
}
