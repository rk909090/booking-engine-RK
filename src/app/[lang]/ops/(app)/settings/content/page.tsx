import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/ops/ops-shell";
import { ReadOnly } from "@/components/ops/read-only";
import { Card, inputClass, labelClass, primaryButton } from "@/components/ops/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { hasLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { saveContentAction } from "@/lib/ops/settings-actions";
import { SettingsHeader, SettingsHidden, settingsContext } from "../shared";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/settings/content">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const dict = await getDictionary(lang);
  return { title: `${dict.settings.tabs.content} · ${dict.settings.title}` };
}

export default async function ContentSettingsPage({ params, searchParams }: PageProps<"/[lang]/ops/settings/content">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
      <Content lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

async function Content({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = await settingsContext(lang, sp);
  if (!ctx.property) return <NoAccess lang={lang} dict={dict} staff={ctx.staff} />;
  const [p] = await getDb().select().from(schema.properties).where(eq(schema.properties.id, ctx.property.id));
  const t = dict.settings.content;
  const c = p.content;
  const pair = (key: "tagline" | "description" | "location", label: string, rows: number, max: number) => (
    <fieldset className="space-y-2">
      <legend className="text-xs font-semibold text-ink">{label}</legend>
      <div className="grid gap-3 lg:grid-cols-2">
        {(["id", "en"] as const).map((l) => (
          <label key={l} className={labelClass}>
            <span>{l === "id" ? t.indonesian : t.english}</span>
            {rows > 1 ? (
              <textarea name={`${key}_${l}`} rows={rows} maxLength={max} defaultValue={c[key]?.[l] ?? ""} className={inputClass} />
            ) : (
              <input name={`${key}_${l}`} maxLength={max} defaultValue={c[key]?.[l] ?? ""} className={inputClass} />
            )}
          </label>
        ))}
      </div>
    </fieldset>
  );

  return (
    <>
      <SettingsHeader lang={lang} dict={dict} current="content" property={ctx.property} properties={ctx.properties} sp={sp} />
      <ReadOnly readOnly={!ctx.canManage} note={dict.settings.readOnly}>
        <form action={saveContentAction} className="space-y-6">
          <SettingsHidden lang={lang} property={p} anchor="" />
          <Card title={t.guestTitle}>
            <div className="space-y-5">
              {pair("tagline", t.tagline, 1, 160)}
              {pair("description", t.description, 5, 3000)}
              {pair("location", t.location, 1, 300)}
            </div>
          </Card>
          <Card id="rules" title={t.rulesTitle}>
            <p className="mb-3 text-xs text-stone">{t.rulesHint}</p>
            <div className="grid gap-3 lg:grid-cols-2">
              {(["id", "en"] as const).map((l) => (
                <label key={l} className={labelClass}>
                  <span>{l === "id" ? t.indonesian : t.english}</span>
                  <textarea name={`rules_${l}`} rows={8} defaultValue={(c.houseRules?.[l] ?? []).join("\n")} className={inputClass} />
                </label>
              ))}
            </div>
          </Card>
          <Card id="invoice" title={t.invoiceTitle}>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className={`${labelClass} sm:col-span-2`}>
                <span>{t.legalName}</span>
                <input name="legalName" maxLength={160} defaultValue={c.invoice?.legalName ?? ""} className={inputClass} />
              </label>
              <label className={`${labelClass} sm:col-span-2`}>
                <span>{t.address}</span>
                <textarea name="address" rows={2} maxLength={400} defaultValue={c.invoice?.address ?? ""} className={inputClass} />
              </label>
              <label className={labelClass}>
                <span>{t.taxId}</span>
                <input name="taxId" maxLength={40} defaultValue={c.invoice?.taxId ?? ""} className={inputClass} />
              </label>
              <label className={labelClass}>
                <span>{t.phone}</span>
                <input name="phone" maxLength={40} defaultValue={c.invoice?.phone ?? ""} className={inputClass} />
              </label>
              <label className={`${labelClass} sm:col-span-2`}>
                <span>{t.email}</span>
                <input name="email" type="email" maxLength={200} defaultValue={c.invoice?.email ?? ""} className={inputClass} />
              </label>
            </div>
          </Card>
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
