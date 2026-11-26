import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { NoAccess } from "@/components/ops/ops-shell";
import { ReadOnly } from "@/components/ops/read-only";
import { Card, inputClass, labelClass, primaryButton } from "@/components/ops/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { hasLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { savePoliciesAction } from "@/lib/ops/settings-actions";
import { pct, SettingsHeader, SettingsHidden, settingsContext } from "../shared";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/settings/policies">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const dict = await getDictionary(lang);
  return { title: `${dict.settings.tabs.policies} · ${dict.settings.title}` };
}

export default async function SettingsPage({ params, searchParams }: PageProps<"/[lang]/ops/settings/policies">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
      <Policies lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

const MAX_TIERS = 5;

async function Policies({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = await settingsContext(lang, sp);
  if (!ctx.property) return <NoAccess lang={lang} dict={dict} staff={ctx.staff} />;
  const [p] = await getDb().select().from(schema.properties).where(eq(schema.properties.id, ctx.property.id));
  const t = dict.settings;
  const tiers = [...p.cancellationTiers].sort((a, b) => b.minDaysBefore - a.minDaysBefore);
  const rows = Array.from({ length: MAX_TIERS }, (_, i) => tiers[i] ?? null);
  const hhmm = (s: string) => s.slice(0, 5);

  return (
    <>
      <SettingsHeader lang={lang} dict={dict} current="policies" property={ctx.property} properties={ctx.properties} sp={sp} canProperties={ctx.canProperties} />
      <ReadOnly readOnly={!ctx.canManage} note={t.readOnly}>
        <form action={savePoliciesAction} className="space-y-6">
          <SettingsHidden lang={lang} property={p} anchor="" />
          <p className="max-w-3xl rounded-xl border border-line bg-white px-4 py-3 text-sm text-stone">{t.newBookingsNote}</p>
          <div className="grid gap-6 xl:grid-cols-2">
            <Card id="times" title={t.times.title}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t.times.checkIn}>
                  <input type="time" name="checkInTime" required defaultValue={hhmm(p.checkInTime)} className={inputClass} />
                </Field>
                <Field label={t.times.checkOut}>
                  <input type="time" name="checkOutTime" required defaultValue={hhmm(p.checkOutTime)} className={inputClass} />
                </Field>
                <Field label={t.times.earlyEarliest}>
                  <input type="time" name="earlyEarliest" required defaultValue={hhmm(p.guestEarlyCheckinEarliest)} className={inputClass} />
                </Field>
                <Field label={t.times.lateLatest}>
                  <input type="time" name="lateLatest" required defaultValue={hhmm(p.guestLateCheckoutLatest)} className={inputClass} />
                </Field>
                <Field label={t.times.turnover} className="sm:col-span-2" hint={t.times.hint}>
                  <input type="number" name="turnoverMinutes" required min={0} max={720} step={5} defaultValue={p.turnoverMinutes} className={inputClass} />
                </Field>
              </div>
            </Card>

            <Card id="money" title={t.money.title}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t.money.tax}>
                  <input name="taxRate" inputMode="decimal" required pattern="\d{1,3}([.,]\d{1,2})?" defaultValue={pct(p.taxRateBp)} className={inputClass} />
                </Field>
                <Field label={t.money.service}>
                  <input name="serviceRate" inputMode="decimal" required pattern="\d{1,3}([.,]\d{1,2})?" defaultValue={pct(p.serviceRateBp)} className={inputClass} />
                </Field>
                <Field label={t.money.deposit} hint={t.money.depositHint}>
                  <input name="depositRate" inputMode="decimal" required pattern="\d{1,3}([.,]\d{1,2})?" defaultValue={pct(p.depositRateBp)} className={inputClass} />
                </Field>
                <Field label={t.money.balanceDays}>
                  <input type="number" name="balanceDueDays" required min={0} max={365} defaultValue={p.balanceDueDays} className={inputClass} />
                </Field>
                <Field label={t.money.hold} className="sm:col-span-2">
                  <input type="number" name="holdMinutes" required min={5} max={120} defaultValue={p.holdMinutes} className={inputClass} />
                </Field>
              </div>
            </Card>

            <Card id="discounts" title={t.discounts.title}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t.discounts.frontOffice}>
                  <input name="discountFrontOffice" inputMode="decimal" required pattern="\d{1,3}([.,]\d{1,2})?" defaultValue={pct(p.discountLimitFrontOfficeBp)} className={inputClass} />
                </Field>
                <Field label={t.discounts.manager}>
                  <input name="discountManager" inputMode="decimal" required pattern="\d{1,3}([.,]\d{1,2})?" defaultValue={pct(p.discountLimitManagerBp)} className={inputClass} />
                </Field>
              </div>
              <p className="mt-3 text-xs text-stone">{t.discounts.hint}</p>
            </Card>
          </div>

          <Card id="cancellation" title={t.cancellation.title}>
            <p className="mb-4 max-w-3xl text-sm text-stone">{t.cancellation.hint}</p>
            <div className="grid gap-3 sm:max-w-xl">
              <div className="grid grid-cols-2 gap-3 text-xs font-medium text-stone">
                <span>{t.cancellation.daysBefore}</span>
                <span>{t.cancellation.charge}</span>
              </div>
              {rows.map((tier, i) => (
                <div key={i} className="grid grid-cols-2 gap-3">
                  <input type="number" name="tierDays" min={0} max={365} defaultValue={tier?.minDaysBefore ?? ""} aria-label={`${t.cancellation.daysBefore} ${i + 1}`} className={inputClass} />
                  <input name="tierCharge" inputMode="decimal" pattern="\d{1,3}([.,]\d{1,2})?" defaultValue={tier ? pct(tier.chargeBp) : ""} aria-label={`${t.cancellation.charge} ${i + 1}`} className={inputClass} />
                </div>
              ))}
              <p className="text-xs text-stone">{t.cancellation.rowHint}</p>
            </div>
          </Card>

          <div className="sticky bottom-4 z-10 flex justify-end">
            <button type="submit" className={`${primaryButton} shadow-lg`}>
              {t.save}
            </button>
          </div>
        </form>
      </ReadOnly>
    </>
  );
}

function Field({ label, hint, className = "", children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <label className={`${labelClass} ${className}`}>
      <span>{label}</span>
      {children}
      {hint ? <span className="block font-normal text-stone">{hint}</span> : null}
    </label>
  );
}
