import { eq } from "drizzle-orm";
import { MapPin } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { NoAccess } from "@/components/ops/ops-shell";
import { ReadOnly } from "@/components/ops/read-only";
import { Card, inputClass, labelClass, primaryButton } from "@/components/ops/ui";
import { MapEmbed, mapsLink } from "@/components/site/map-embed";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { hasLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { saveProfileAction } from "@/lib/ops/settings-actions";
import { SettingsHeader, SettingsHidden, settingsContext } from "./shared";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/settings">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).settings.title };
}

export default async function SettingsPage({ params, searchParams }: PageProps<"/[lang]/ops/settings">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
      <Profile lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

async function Profile({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = await settingsContext(lang, sp);
  if (!ctx.property) return <NoAccess lang={lang} dict={dict} staff={ctx.staff} />;
  const [p] = await getDb().select().from(schema.properties).where(eq(schema.properties.id, ctx.property.id));
  const t = dict.settings.profile;
  const c = dict.settings.content;
  const content = p.content;
  const pair = (key: "location" | "directions", rows: number, max: number) => (
    <div className="grid gap-3 lg:grid-cols-2">
      {(["id", "en"] as const).map((l) => (
        <label key={l} className={labelClass}>
          <span>{l === "id" ? c.indonesian : c.english}</span>
          {rows > 1 ? (
            <textarea name={`${key}_${l}`} rows={rows} maxLength={max} defaultValue={content[key]?.[l] ?? ""} className={inputClass} />
          ) : (
            <input name={`${key}_${l}`} maxLength={max} defaultValue={content[key]?.[l] ?? ""} className={inputClass} />
          )}
        </label>
      ))}
    </div>
  );

  return (
    <>
      <SettingsHeader lang={lang} dict={dict} current="profile" property={ctx.property} properties={ctx.properties} sp={sp} canProperties={ctx.canProperties} canAccess={ctx.canAccess} />
      <ReadOnly readOnly={!ctx.canManage} note={dict.settings.readOnly}>
        <form action={saveProfileAction} className="space-y-6">
          <SettingsHidden lang={lang} property={p} anchor="" />
          <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
            <div className="space-y-6">
              <Card title={t.title}>
                <div className="space-y-4">
                  <Field label={t.name}>
                    <input name="name" defaultValue={p.name} required minLength={2} maxLength={80} className={inputClass} />
                  </Field>
                  <fieldset className="space-y-2">
                    <legend className="text-xs font-semibold text-ink">{t.area}</legend>
                    {pair("location", 1, 300)}
                    <p className="text-xs text-stone">{t.areaHint}</p>
                  </fieldset>
                  <Field label={t.address} hint={t.addressHint}>
                    <textarea name="address" rows={2} maxLength={400} defaultValue={content.address ?? ""} className={inputClass} />
                  </Field>
                </div>
              </Card>

              <Card title={t.contactTitle}>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label={t.phone}>
                    <input name="phone" type="tel" maxLength={20} defaultValue={content.contact?.phone ?? ""} className={inputClass} />
                  </Field>
                  <Field label={t.whatsapp}>
                    <input name="whatsapp" type="tel" maxLength={20} defaultValue={content.contact?.whatsapp ?? ""} className={inputClass} />
                  </Field>
                  <Field label={t.email}>
                    <input name="email" type="email" maxLength={200} defaultValue={content.contact?.email ?? ""} className={inputClass} />
                  </Field>
                </div>
              </Card>

              <Card title={t.directions}>
                <p className="mb-3 text-xs text-stone">{t.directionsHint}</p>
                {pair("directions", 4, 2000)}
              </Card>
            </div>

            <div className="space-y-6">
              <Card id="map" title={t.mapTitle}>
                <div className="space-y-3">
                  {content.geo ? (
                    <>
                      <MapEmbed lat={content.geo.lat} lng={content.geo.lng} title={p.name} className="h-56 w-full rounded-xl border border-line" />
                      <a href={mapsLink(content.geo.lat, content.geo.lng)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs font-medium text-lagoon hover:underline">
                        <MapPin className="size-3.5" aria-hidden />
                        {t.openMap}
                      </a>
                    </>
                  ) : (
                    <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-stone">{t.mapNone}</p>
                  )}
                  <Field label={t.map} hint={t.mapHint}>
                    <input name="map" maxLength={2000} defaultValue={content.geo ? `${content.geo.lat}, ${content.geo.lng}` : ""} placeholder="-8.5069, 115.2625" className={inputClass} />
                  </Field>
                </div>
              </Card>

              <Card title={t.systemTitle}>
                <dl className="space-y-2 text-sm">
                  <Row label={t.webAddress} value={`/villas/${p.slug}`} />
                  <Row label={t.timezone} value={p.timezone} />
                  <Row label={t.currency} value={p.currency} />
                </dl>
                <p className="mt-2 text-xs text-stone">{t.fixed}</p>
              </Card>
            </div>
          </div>
          <div className="sticky bottom-4 z-10 flex justify-end">
            <button type="submit" className={`${primaryButton} shadow-lg`}>
              {dict.settings.save}
            </button>
          </div>
        </form>
      </ReadOnly>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className={labelClass}>
      <span>{label}</span>
      {children}
      {hint ? <span className="block font-normal text-stone">{hint}</span> : null}
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-stone">{label}</dt>
      <dd className="font-mono text-xs text-ink">{value}</dd>
    </div>
  );
}
