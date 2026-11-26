import { asc, eq, inArray } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { NoAccess } from "@/components/ops/ops-shell";
import { OwnersTabs, type OwnersTab } from "@/components/ops/owners-tabs";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { todayIn } from "@/domain/dates";
import { COMMISSION_SOURCES } from "@/domain/owners";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { assignUnitAction, createOwnerAction, endOwnershipAction, setCommissionAction, updateOwnerAction } from "@/lib/ops/owner-actions";
import { visibleProperties } from "@/lib/ops/queries";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/owners/setup">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).owners.tabs.setup };
}

export default async function OwnersSetupPage({ params, searchParams }: PageProps<"/[lang]/ops/owners/setup">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
      <Setup lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";
const button = "rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep";
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function Setup({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "owners.view").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const t = dict.owners;
  const sp = await searchParams;
  const properties = (await visibleProperties(staff.actor)).filter((p) => can(staff.actor, "owners.view", p.id).allowed);
  const chosen = properties.find((p) => p.slug === one(sp.property)) ?? properties[0];
  if (!chosen) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const db = getDb();
  const [property] = await db.select().from(schema.properties).where(eq(schema.properties.id, chosen.id));
  const canManage = can(staff.actor, "owners.manage", property.id).allowed;
  const today = todayIn(property.timezone);
  const units = await db
    .select({ id: schema.units.id, code: schema.units.code, typeName: schema.unitTypes.name })
    .from(schema.units)
    .innerJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.units.unitTypeId))
    .where(eq(schema.units.propertyId, property.id))
    .orderBy(asc(schema.units.code));
  const ownerships = units.length
    ? await db.select().from(schema.unitOwnerships).where(inArray(schema.unitOwnerships.unitId, units.map((u) => u.id))).orderBy(asc(schema.unitOwnerships.startDate))
    : [];
  const owners = await db.select().from(schema.owners).orderBy(asc(schema.owners.fullName));
  const ownerName = new Map(owners.map((o) => [o.id, o.fullName]));
  const current = (unitId: string) => ownerships.filter((o) => o.unitId === unitId && o.startDate <= today && (o.endDate === null || o.endDate > today))[0] ?? null;
  const upcoming = (unitId: string) => ownerships.filter((o) => o.unitId === unitId && o.startDate > today);
  const day = (d: string) => formatDate(d, lang, { day: "numeric", month: "short", year: "numeric" });
  const tabs: OwnersTab[] = ["statements", "setup", ...(can(staff.actor, "owners.expense", property.id).allowed ? (["expenses"] as const) : [])];
  const done = one(sp.done) ? t.saved : undefined;
  const errorCode = one(sp.error);
  const error = errorCode ? ((t.errors as Record<string, string>)[errorCode] ?? t.errors.not_found) : undefined;
  const hidden = (anchor: string) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="property" value={property.slug} />
      <input type="hidden" name="anchor" value={anchor} />
      <input type="hidden" name="propertyId" value={property.id} />
    </>
  );

  return (
    <>
      <h1 className="font-display text-3xl text-lagoon">{t.title}</h1>
      <p className="mt-1 max-w-3xl text-sm text-stone">{t.setupIntro}</p>
      <OwnersTabs lang={lang} dict={dict} current="setup" tabs={tabs} property={property.slug} properties={properties} />
      <div className="mt-4 space-y-2">
        {done ? <SuccessNote>{done}</SuccessNote> : null}
        <ErrorNote>{error}</ErrorNote>
      </div>

      <Section id="villas" title={t.villasTitle} intro={t.villasIntro}>
        <ul className="divide-y divide-line">
          {units.map((u) => {
            const own = current(u.id);
            const later = upcoming(u.id);
            return (
              <li key={u.id} className="grid gap-3 py-3 lg:grid-cols-[1fr_1.6fr] lg:items-start">
                <div className="text-sm">
                  <p className="font-medium text-ink">
                    {u.code} · <span className="font-normal text-stone">{u.typeName}</span>
                  </p>
                  {own ? (
                    <p className="text-ink">
                      {ownerName.get(own.ownerId)} · {format(t.feeShort, { percent: own.managementFeeBp / 100 })} · {format(t.since, { date: day(own.startDate) })}
                      {own.endDate ? ` · ${format(t.until, { date: day(own.endDate) })}` : ""}
                    </p>
                  ) : (
                    <p className="text-danger">{t.noOwner}</p>
                  )}
                  {later.map((o) => (
                    <p key={o.id} className="text-xs text-stone">
                      {format(t.upcoming, { owner: ownerName.get(o.ownerId) ?? "—", date: day(o.startDate) })}
                    </p>
                  ))}
                </div>
                {canManage ? (
                  <div className="space-y-2">
                    <form action={assignUnitAction} className="grid gap-2 sm:grid-cols-[1.4fr_1fr_0.7fr_auto] sm:items-end">
                      {hidden("villas")}
                      <input type="hidden" name="unitId" value={u.id} />
                      <label className="space-y-1 text-xs text-stone">
                        <span>{own ? t.newOwner : t.owner}</span>
                        <select name="ownerId" required className={input} defaultValue="">
                          <option value="" disabled>
                            {t.chooseOwner}
                          </option>
                          {owners.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.fullName}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1 text-xs text-stone">
                        <span>{t.fromDate}</span>
                        <input type="date" name="startDate" required defaultValue={today} className={input} />
                      </label>
                      <label className="space-y-1 text-xs text-stone">
                        <span>{t.feePercent}</span>
                        <input name="feePercent" inputMode="decimal" required defaultValue={own ? String(own.managementFeeBp / 100) : "20"} className={input} />
                      </label>
                      <button type="submit" className={button}>
                        {own ? t.changeOwner : t.assign}
                      </button>
                    </form>
                    {own && !own.endDate ? (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-stone hover:text-ink">{t.endOwnership}</summary>
                        <form action={endOwnershipAction} className="mt-2 flex flex-wrap items-end gap-2">
                          {hidden("villas")}
                          <input type="hidden" name="ownershipId" value={own.id} />
                          <label className="space-y-1 text-xs text-stone">
                            <span className="block">{t.endDate}</span>
                            <input type="date" name="endDate" required className={input} />
                          </label>
                          <button type="submit" className="rounded-lg border border-danger px-3 py-2 text-xs text-danger hover:bg-danger/10">
                            {t.endOwnership}
                          </button>
                        </form>
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Section>

      <Section id="owners" title={t.ownersTitle} intro={t.ownersIntro}>
        {owners.length ? (
          <ul className="divide-y divide-line text-sm">
            {owners.map((o) => {
              const theirs = units.filter((u) => current(u.id)?.ownerId === o.id).map((u) => u.code);
              return (
                <li key={o.id} className="py-3">
                  <p className="font-medium text-ink">{o.fullName}</p>
                  <p className="text-xs text-stone">
                    {[o.email, o.phone].filter(Boolean).join(" · ") || t.noContact}
                    {theirs.length ? ` · ${theirs.join(", ")}` : ""}
                  </p>
                  {canManage ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-lagoon">{t.edit}</summary>
                      <form action={updateOwnerAction} className="mt-2 grid gap-2 sm:grid-cols-4">
                        {hidden("owners")}
                        <input type="hidden" name="ownerId" value={o.id} />
                        <input name="fullName" required defaultValue={o.fullName} aria-label={t.fullName} className={input} />
                        <input name="email" type="email" defaultValue={o.email ?? ""} aria-label={t.email} placeholder={t.email} className={input} />
                        <input name="phone" defaultValue={o.phone ?? ""} aria-label={t.phone} placeholder={t.phone} className={input} />
                        <button type="submit" className={button}>
                          {t.save}
                        </button>
                      </form>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-stone">{t.noOwnersYet}</p>
        )}
        {canManage ? (
          <form action={createOwnerAction} className="mt-4 grid gap-3 sm:grid-cols-[1.3fr_1.3fr_1fr_auto] sm:items-end">
            {hidden("owners")}
            <label className="space-y-1 text-xs text-stone">
              <span>{t.fullName}</span>
              <input name="fullName" required maxLength={120} className={input} />
            </label>
            <label className="space-y-1 text-xs text-stone">
              <span>{t.email}</span>
              <input name="email" type="email" maxLength={200} className={input} />
            </label>
            <label className="space-y-1 text-xs text-stone">
              <span>{t.phone}</span>
              <input name="phone" maxLength={40} className={input} />
            </label>
            <button type="submit" className={button}>
              {t.addOwner}
            </button>
          </form>
        ) : null}
      </Section>

      <Section id="commission" title={t.commissionTitle} intro={t.commissionIntro}>
        <form action={setCommissionAction} className="grid gap-3 sm:grid-cols-6 sm:items-end">
          {hidden("commission")}
          {COMMISSION_SOURCES.map((s) => (
            <label key={s} className="space-y-1 text-xs text-stone">
              <span>{dict.resList.sources[s]} (%)</span>
              <input name={`rate_${s}`} inputMode="decimal" disabled={!canManage} defaultValue={property.commissionRates[s] ? String(property.commissionRates[s]! / 100) : ""} placeholder="0" className={input} />
            </label>
          ))}
          {canManage ? (
            <button type="submit" className={button}>
              {t.save}
            </button>
          ) : null}
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
