import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { NoAccess, OpsNav, OpsShell } from "@/components/ops/ops-shell";
import { ReportTabs } from "@/components/ops/report-tabs";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { recentRuns, REPORT_KINDS, SEND_HOUR } from "@/domain/report-schedule";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { channelStatus } from "@/lib/notifications/providers";
import { visibleProperties } from "@/lib/ops/queries";
import { addRecipientAction, removeRecipientAction } from "@/lib/ops/report-schedule-actions";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/reports/schedules">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).reports.tabSchedules };
}

export default async function SchedulesPage({ params, searchParams }: PageProps<"/[lang]/ops/reports/schedules">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <OpsShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Schedules lang={lang} dict={dict} searchParams={searchParams} />
      </Suspense>
    </OpsShell>
  );
}

const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";

async function Schedules({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "performance.view").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const t = dict.reports;
  const sp = await searchParams;
  const properties = (await visibleProperties(staff.actor)).filter((p) => can(staff.actor, "performance.view", p.id).allowed);
  const property = properties.find((p) => p.slug === sp.property) ?? properties[0];
  if (!property) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const canManage = can(staff.actor, "reports.schedule", property.id).allowed;
  const db = getDb();
  const subs = await db
    .select({ sub: schema.reportSubscriptions, staffName: schema.staffMembers.fullName, staffEmail: schema.staffMembers.email })
    .from(schema.reportSubscriptions)
    .leftJoin(schema.staffMembers, eq(schema.staffMembers.id, schema.reportSubscriptions.staffId))
    .where(eq(schema.reportSubscriptions.propertyId, property.id))
    .orderBy(asc(schema.reportSubscriptions.createdAt));
  const access = await db.select({ staffId: schema.staffPropertyAccess.staffId }).from(schema.staffPropertyAccess).where(eq(schema.staffPropertyAccess.propertyId, property.id));
  const eligible = await db
    .select({ id: schema.staffMembers.id, fullName: schema.staffMembers.fullName, role: schema.staffMembers.role })
    .from(schema.staffMembers)
    .where(
      and(
        eq(schema.staffMembers.isActive, true),
        or(eq(schema.staffMembers.role, "director"), access.length ? and(eq(schema.staffMembers.role, "branch_manager"), inArray(schema.staffMembers.id, access.map((a) => a.staffId))) : undefined),
      ),
    )
    .orderBy(asc(schema.staffMembers.fullName));
  const runs = await recentRuns(db, [property.id]);
  const emailOn = channelStatus().email;
  const fmt = new Intl.DateTimeFormat(lang === "id" ? "id-ID" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: property.timezone });
  const done = typeof sp.done === "string" ? t.scheduleSaved : undefined;
  const error = typeof sp.error === "string" ? ((t.scheduleErrors as Record<string, string>)[sp.error] ?? t.scheduleErrors.not_found) : undefined;
  const kinds = t.scheduleKinds as Record<string, { title: string; intro: string }>;
  const statuses = t.runStatus as Record<string, string>;
  const roles = dict.ops.roles as Record<string, string>;
  const hidden = (kind: string) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="property" value={property.slug} />
      <input type="hidden" name="propertyId" value={property.id} />
      <input type="hidden" name="kind" value={kind} />
    </>
  );

  return (
    <>
      <OpsNav lang={lang} dict={dict} staff={staff} current="reports" />
      <h1 className="font-display text-3xl text-lagoon">{t.title}</h1>
      <ReportTabs lang={lang} dict={dict} current="schedules" property={property.slug} />
      <p className="mt-3 max-w-3xl text-sm text-stone">{format(t.schedulesIntro, { hour: `${String(SEND_HOUR).padStart(2, "0")}:00` })}</p>
      {!emailOn ? <p className="mt-3 rounded-lg border border-terracotta/40 bg-sand px-4 py-3 text-sm text-ink">{t.emailNotConfigured}</p> : null}
      {properties.length > 1 ? (
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          {properties.map((p) => (
            <a key={p.slug} href={`/${lang}/ops/reports/schedules?property=${p.slug}`} className={`rounded-full border px-3 py-1 ${p.slug === property.slug ? "border-lagoon bg-lagoon text-ivory" : "border-line text-ink hover:border-lagoon"}`}>
              {p.name}
            </a>
          ))}
        </div>
      ) : null}
      <div className="mt-4 space-y-2">
        {done ? <SuccessNote>{done}</SuccessNote> : null}
        <ErrorNote>{error}</ErrorNote>
      </div>

      {REPORT_KINDS.map((kind) => {
        const list = subs.filter((s) => s.sub.kind === kind);
        return (
          <section key={kind} id={kind} className="mt-6 scroll-mt-6 rounded-xl border border-line bg-white/70 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-xl text-lagoon">{kinds[kind].title}</h2>
                <p className="mt-1 text-sm text-stone">{kinds[kind].intro}</p>
              </div>
              <a href={`/api/ops/reports/preview?property=${property.slug}&kind=${kind}&locale=${lang}`} target="_blank" rel="noopener" className="rounded-lg border border-lagoon px-3 py-1.5 text-sm text-lagoon hover:bg-lagoon-soft">
                {t.preview}
              </a>
            </div>
            {list.length ? (
              <ul className="mt-3 divide-y divide-line text-sm">
                {list.map(({ sub, staffName, staffEmail }) => (
                  <li key={sub.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <span className="text-ink">{staffName ?? sub.email}</span>
                      <span className="block text-xs text-stone">
                        {staffName ? staffEmail : t.otherAddress} · {sub.locale === "en" ? "English" : "Bahasa Indonesia"}
                      </span>
                    </span>
                    {canManage ? (
                      <form action={removeRecipientAction}>
                        {hidden(kind)}
                        <input type="hidden" name="subscriptionId" value={sub.id} />
                        <button type="submit" className="text-xs text-danger hover:underline">
                          {t.removeRecipient}
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-stone">{t.noRecipients}</p>
            )}
            {canManage ? (
              <form action={addRecipientAction} className="mt-3 grid gap-2 sm:grid-cols-[1.4fr_1.4fr_0.8fr_auto] sm:items-end">
                {hidden(kind)}
                <label className="space-y-1 text-xs text-stone">
                  <span>{t.recipient}</span>
                  <select name="who" defaultValue="email" className={input}>
                    {eligible.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.fullName} · {roles[s.role] ?? s.role}
                      </option>
                    ))}
                    <option value="email">{t.otherAddressOption}</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs text-stone">
                  <span>{t.emailIfOther}</span>
                  <input name="email" type="email" maxLength={200} placeholder="akuntan@example.com" className={input} />
                </label>
                <label className="space-y-1 text-xs text-stone">
                  <span>{t.language}</span>
                  <select name="locale" defaultValue={lang} className={input}>
                    <option value="id">Bahasa Indonesia</option>
                    <option value="en">English</option>
                  </select>
                </label>
                <button type="submit" className="rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
                  {t.addRecipient}
                </button>
              </form>
            ) : null}
          </section>
        );
      })}

      <section className="mt-6 rounded-xl border border-line bg-white/70 p-5">
        <h2 className="font-display text-xl text-lagoon">{t.runsTitle}</h2>
        {runs.length ? (
          <ul className="mt-3 divide-y divide-line text-sm">
            {runs.map((r) => (
              <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="text-ink">
                  {kinds[r.kind]?.title ?? r.kind} · {r.periodKey}
                  {r.lastError ? <span className="block text-xs text-danger">{r.lastError}</span> : null}
                </span>
                <span className="text-right text-xs text-stone">
                  {statuses[r.status] ?? r.status}
                  {r.sentAt ? ` · ${fmt.format(r.sentAt)} · ${format(t.recipientsCount, { count: r.recipients })}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-stone">{t.noRuns}</p>
        )}
      </section>
    </>
  );
}
