import { asc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/ops/ops-shell";
import { ReadOnly } from "@/components/ops/read-only";
import { Card, inputClass, labelClass, Pill, primaryButton, secondaryButton } from "@/components/ops/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { createUnitAction, createUnitTypeAction, saveUnitTypeAction, setUnitActiveAction } from "@/lib/ops/settings-actions";
import { SettingsHeader, SettingsHidden, settingsContext } from "../shared";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/settings/villas">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const dict = await getDictionary(lang);
  return { title: `${dict.settings.tabs.villas} · ${dict.settings.title}` };
}

export default async function VillaSettingsPage({ params, searchParams }: PageProps<"/[lang]/ops/settings/villas">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
      <Villas lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

async function Villas({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = await settingsContext(lang, sp);
  if (!ctx.property) return <NoAccess lang={lang} dict={dict} staff={ctx.staff} />;
  const property = ctx.property;
  const db = getDb();
  const [types, units] = await Promise.all([
    db.select().from(schema.unitTypes).where(eq(schema.unitTypes.propertyId, property.id)).orderBy(asc(schema.unitTypes.sortOrder), asc(schema.unitTypes.name)),
    db.select().from(schema.units).where(eq(schema.units.propertyId, property.id)).orderBy(asc(schema.units.code)),
  ]);
  const t = dict.settings.villas;
  const c = dict.settings.content;
  const defaults = Object.values(dict.tasks.defaultChecklist);
  const hidden = (anchor: string) => <SettingsHidden lang={lang} property={property} anchor={anchor} />;

  return (
    <>
      <SettingsHeader lang={lang} dict={dict} current="villas" property={property} properties={ctx.properties} sp={sp} canProperties={ctx.canProperties} />
      <ReadOnly readOnly={!ctx.canManage} note={dict.settings.readOnly}>
        <div className="space-y-6">
          {types.map((type) => {
            const ofType = units.filter((u) => u.unitTypeId === type.id);
            const anchor = `type-${type.slug}`;
            return (
              <Card
                key={type.id}
                id={anchor}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {type.name}
                    {type.isPublished ? <Pill tone="good">{t.published}</Pill> : <Pill>{t.notPublished}</Pill>}
                    <span className="text-xs font-normal text-stone">
                      {format(t.unitsCount, { count: ofType.length })} · {formatMoney(type.baseRate, lang)}
                    </span>
                  </span>
                }
              >
                <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
                  <form action={saveUnitTypeAction} className="space-y-4">
                    {hidden(anchor)}
                    <input type="hidden" name="unitTypeId" value={type.id} />
                    <div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
                      <label className={labelClass}>
                        <span>{t.typeName}</span>
                        <input name="name" defaultValue={type.name} required minLength={2} maxLength={80} className={inputClass} />
                      </label>
                      <label className={labelClass}>
                        <span>{t.bedrooms}</span>
                        <input type="number" name="bedrooms" min={1} max={20} required defaultValue={type.bedrooms} className={inputClass} />
                      </label>
                      <label className={labelClass}>
                        <span>{t.maxGuests}</span>
                        <input type="number" name="maxGuests" min={1} max={40} required defaultValue={type.maxGuests} className={inputClass} />
                      </label>
                    </div>
                    {(["summary", "description"] as const).map((key) => (
                      <fieldset key={key} className="space-y-2">
                        <legend className="text-xs font-semibold text-ink">{key === "summary" ? t.summary : t.description}</legend>
                        <div className="grid gap-3 lg:grid-cols-2">
                          {(["id", "en"] as const).map((l) => (
                            <label key={l} className={labelClass}>
                              <span>{l === "id" ? c.indonesian : c.english}</span>
                              <textarea name={`${key}_${l}`} rows={key === "summary" ? 2 : 4} maxLength={key === "summary" ? 300 : 3000} defaultValue={type.content[key]?.[l] ?? ""} className={inputClass} />
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ))}
                    <label className={labelClass}>
                      <span>{t.checklist}</span>
                      <textarea name="checklist" rows={5} defaultValue={(type.content.inspectionChecklist?.length ? type.content.inspectionChecklist : defaults).join("\n")} className={inputClass} />
                      <span className="block font-normal">{t.checklistHint}</span>
                    </label>
                    <div className="flex flex-wrap items-center gap-4">
                      <label className="flex items-center gap-2 text-sm text-ink">
                        <input type="checkbox" name="isPublished" defaultChecked={type.isPublished} className="size-4 accent-lagoon" />
                        {t.published}
                      </label>
                      <button type="submit" className={primaryButton}>
                        {t.saveType}
                      </button>
                      <Link href={`/${lang}/ops/rates?property=${property.slug}`} className="text-xs text-lagoon hover:underline">
                        {t.ratesLink}
                      </Link>
                    </div>
                  </form>

                  <div className="space-y-3">
                    <p className="text-xs font-semibold text-ink">{t.units}</p>
                    <ul className="divide-y divide-line/70 rounded-xl border border-line">
                      {ofType.map((u) => (
                        <li key={u.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                          <span className={u.isActive ? "text-ink" : "text-stone line-through"}>
                            <span className="font-mono">{u.code}</span>
                            <span className="block text-xs text-stone">{u.name}</span>
                          </span>
                          <form action={setUnitActiveAction}>
                            {hidden(anchor)}
                            <input type="hidden" name="unitId" value={u.id} />
                            <input type="hidden" name="active" value={u.isActive ? "false" : "true"} />
                            <button type="submit" className="rounded-lg border border-line px-2.5 py-1 text-xs text-ink hover:bg-sand">
                              {u.isActive ? t.deactivate : t.activate}
                            </button>
                          </form>
                        </li>
                      ))}
                    </ul>
                    <form action={createUnitAction} className="space-y-2 rounded-xl border border-dashed border-line p-3">
                      {hidden(anchor)}
                      <input type="hidden" name="unitTypeId" value={type.id} />
                      <p className="text-xs font-semibold text-ink">{t.addUnit}</p>
                      <div className="grid grid-cols-2 gap-2">
                        <input name="code" required maxLength={20} pattern="[A-Za-z0-9][A-Za-z0-9-]{1,19}" placeholder={t.unitCode} aria-label={t.unitCode} className={`${inputClass} font-mono uppercase`} />
                        <input name="name" maxLength={80} placeholder={t.unitName} aria-label={t.unitName} className={inputClass} />
                      </div>
                      <p className="text-xs text-stone">{t.addUnitHint}</p>
                      <button type="submit" className={secondaryButton}>
                        {t.addUnit}
                      </button>
                    </form>
                  </div>
                </div>
              </Card>
            );
          })}

          <Card id="new-type" title={t.newType}>
            <form action={createUnitTypeAction} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[2fr_1fr_1fr_1.5fr_auto] xl:items-end">
              {hidden("new-type")}
              <label className={labelClass}>
                <span>{t.typeName}</span>
                <input name="name" required minLength={2} maxLength={80} className={inputClass} />
              </label>
              <label className={labelClass}>
                <span>{t.bedrooms}</span>
                <input type="number" name="bedrooms" min={1} max={20} required defaultValue={1} className={inputClass} />
              </label>
              <label className={labelClass}>
                <span>{t.maxGuests}</span>
                <input type="number" name="maxGuests" min={1} max={40} required defaultValue={2} className={inputClass} />
              </label>
              <label className={labelClass}>
                <span>{t.baseRate}</span>
                <input name="baseRate" inputMode="numeric" required className={inputClass} />
              </label>
              <button type="submit" className={primaryButton}>
                {t.create}
              </button>
            </form>
            <p className="mt-3 text-xs text-stone">{t.newTypeHint}</p>
          </Card>
        </div>
      </ReadOnly>
    </>
  );
}
