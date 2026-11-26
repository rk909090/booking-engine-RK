import { and, asc, gt, inArray, sql } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/ops/ops-shell";
import { Card, dangerButton, inputClass, labelClass, Pill, primaryButton, secondaryButton } from "@/components/ops/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { todayIn } from "@/domain/dates";
import { TIMEZONES } from "@/domain/settings";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { createPropertyAction, setPropertyActiveAction } from "@/lib/ops/settings-actions";
import { SettingsHeader, settingsContext } from "../shared";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/settings/properties">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const dict = await getDictionary(lang);
  return { title: `${dict.settings.tabs.properties} · ${dict.settings.title}` };
}

export default async function PropertiesPage({ params, searchParams }: PageProps<"/[lang]/ops/settings/properties">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
      <Properties lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

async function Properties({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = await settingsContext(lang, sp);
  if (!ctx.canProperties) return <NoAccess lang={lang} dict={dict} staff={ctx.staff} />;
  const t = dict.settings.properties;
  const db = getDb();
  const properties = await db.select().from(schema.properties).orderBy(asc(schema.properties.name));
  const ids = properties.map((p) => p.id);
  const today = todayIn(properties[0]?.timezone ?? "Asia/Makassar");
  const [types, units, upcoming] = ids.length
    ? await Promise.all([
        db.select({ id: schema.unitTypes.propertyId, n: sql<number>`count(*)::int` }).from(schema.unitTypes).where(inArray(schema.unitTypes.propertyId, ids)).groupBy(schema.unitTypes.propertyId),
        db.select({ id: schema.units.propertyId, n: sql<number>`count(*)::int` }).from(schema.units).where(and(inArray(schema.units.propertyId, ids), sql`${schema.units.isActive}`)).groupBy(schema.units.propertyId),
        db
          .select({ id: schema.reservations.propertyId, n: sql<number>`count(*)::int` })
          .from(schema.reservations)
          .where(and(inArray(schema.reservations.propertyId, ids), inArray(schema.reservations.status, ["hold", "confirmed", "in_house"]), gt(schema.reservations.checkOut, today)))
          .groupBy(schema.reservations.propertyId),
      ])
    : [[], [], []];
  const n = (rows: Array<{ id: string; n: number }>, id: string) => rows.find((r) => r.id === id)?.n ?? 0;
  const tz = t.tz as Record<string, string>;

  return (
    <>
      <SettingsHeader lang={lang} dict={dict} current="properties" property={ctx.property} properties={ctx.properties} sp={sp} canProperties={ctx.canProperties} />
      <p className="mb-4 max-w-3xl text-sm text-stone">{t.intro}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        {properties.map((p) => (
          <Card key={p.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="flex flex-wrap items-center gap-2 font-display text-xl text-ink">
                  {p.name}
                  {p.isActive ? <Pill tone="good">{t.active}</Pill> : <Pill tone="bad">{t.inactive}</Pill>}
                </h2>
                <p className="mt-1 text-xs text-stone">
                  {p.content.location?.[lang] ?? p.slug} · {tz[p.timezone] ?? p.timezone}
                </p>
                <p className="mt-2 text-sm text-ink">
                  {format(t.types, { count: n(types, p.id) })} · {format(t.villas, { count: n(units, p.id) })} · {format(t.upcoming, { count: n(upcoming, p.id) })}
                </p>
              </div>
              <Link href={`/${lang}/ops/settings?property=${p.slug}`} className={secondaryButton}>
                {t.open}
              </Link>
            </div>
            <div className="mt-4 border-t border-line/70 pt-4">
              {p.isActive ? (
                <form action={setPropertyActiveAction} className="flex flex-wrap items-center gap-3">
                  <input type="hidden" name="lang" value={lang} />
                  <input type="hidden" name="propertyId" value={p.id} />
                  <input type="hidden" name="active" value="false" />
                  <p className="w-full text-xs text-stone">{t.deactivateHint}</p>
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input type="checkbox" name="confirm" value="yes" required className="size-4 accent-danger" />
                    {t.confirm}
                  </label>
                  <button type="submit" className={dangerButton}>
                    {t.deactivate}
                  </button>
                </form>
              ) : (
                <form action={setPropertyActiveAction}>
                  <input type="hidden" name="lang" value={lang} />
                  <input type="hidden" name="propertyId" value={p.id} />
                  <input type="hidden" name="active" value="true" />
                  <button type="submit" className={primaryButton}>
                    {t.activate}
                  </button>
                </form>
              )}
            </div>
          </Card>
        ))}
      </div>

      <Card id="new" title={t.newTitle} className="mt-6">
        <form action={createPropertyAction} className="grid gap-4 sm:grid-cols-[2fr_1.5fr_auto] sm:items-end">
          <input type="hidden" name="lang" value={lang} />
          <label className={labelClass}>
            <span>{t.name}</span>
            <input name="name" required minLength={2} maxLength={80} className={inputClass} />
          </label>
          <label className={labelClass}>
            <span>{t.timezone}</span>
            <select name="timezone" defaultValue="Asia/Makassar" className={inputClass}>
              {TIMEZONES.map((z) => (
                <option key={z} value={z}>
                  {tz[z] ?? z}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={primaryButton}>
            {t.create}
          </button>
        </form>
        <p className="mt-3 text-xs text-stone">{t.newHint}</p>
      </Card>
    </>
  );
}
