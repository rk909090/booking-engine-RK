import { and, desc, eq, inArray } from "drizzle-orm";
import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { GuestBadges } from "@/components/ops/guest-badges";
import { OpsNav, OpsShell } from "@/components/ops/ops-shell";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { GUEST_TAGS, guestStats, possibleDuplicates } from "@/domain/guests";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatDateRange, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can, type Action } from "@/lib/authz/permissions";
import { guestScope } from "@/lib/ops/guest-access";
import { anonymizeGuestAction, mergeGuestAction, updateGuestAction } from "@/lib/ops/guest-actions";

type Props = PageProps<"/[lang]/ops/guests/[id]">;

export async function generateMetadata(): Promise<Metadata> {
  const lang = await rootLang();
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).guests.profileTitle, robots: { index: false } };
}

export default async function GuestProfilePage({ params, searchParams }: Props) {
  const lang = await rootLang();
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <OpsShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Profile lang={lang} dict={dict} params={params} searchParams={searchParams} />
      </Suspense>
    </OpsShell>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";
const button = "rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep";

async function Profile({ lang, dict, params, searchParams }: { lang: Locale; dict: Dictionary; params: Props["params"]; searchParams: Props["searchParams"] }) {
  const staff = await requireStaff(lang);
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!UUID.test(id) || !can(staff.actor, "guest.view").allowed) notFound();
  const scope = await guestScope(staff.actor, id);
  if (!scope.visible) notFound();
  const db = getDb();
  const [g] = await db.select().from(schema.guests).where(eq(schema.guests.id, id));
  if (!g) notFound();
  const t = dict.guests;
  const may = (a: Action) => scope.propertyIds.some((p) => can(staff.actor, a, p).allowed);
  const propertyFilter = staff.actor.role === "director" ? null : scope.propertyIds;
  const stats = (await guestStats(db, [g.id], propertyFilter)).get(g.id)!;
  const bookings = await db
    .select({ r: schema.reservations, unitCode: schema.units.code, propertyName: schema.properties.name })
    .from(schema.reservations)
    .innerJoin(schema.units, eq(schema.units.id, schema.reservations.unitId))
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .where(and(eq(schema.reservations.guestId, g.id), propertyFilter ? inArray(schema.reservations.propertyId, propertyFilter) : undefined))
    .orderBy(desc(schema.reservations.checkIn));
  const duplicates = may("guest.merge") ? await possibleDuplicates(db, g) : [];
  const otherRaw = typeof sp.other === "string" && UUID.test(sp.other) ? sp.other : null;
  const other = otherRaw && (await guestScope(staff.actor, otherRaw)).visible ? (await db.select().from(schema.guests).where(eq(schema.guests.id, otherRaw)))[0] : undefined;
  const mergeCandidates = [...(other && !duplicates.some((d) => d.id === other.id) ? [{ id: other.id, fullName: other.fullName, email: other.email, phone: other.phone }] : []), ...duplicates];
  const errorCode = typeof sp.error === "string" ? sp.error : null;
  const error = errorCode ? ((t.errors as Record<string, string>)[errorCode] ?? t.errors.not_found) : undefined;
  const statuses = dict.booking.status as Record<string, string>;
  const hidden = (anchor: string) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="guestId" value={g.id} />
      <input type="hidden" name="anchor" value={anchor} />
    </>
  );

  return (
    <>
      <OpsNav lang={lang} dict={dict} staff={staff} current="guests" />
      <Link href={`/${lang}/ops/guests`} className="text-sm text-lagoon hover:underline">
        ← {t.back}
      </Link>
      <h1 className="mt-3 font-display text-3xl text-lagoon">
        {g.anonymizedAt ? t.anonymized : g.fullName} <GuestBadges dict={dict} tags={g.tags} pastStays={0} />
      </h1>
      {g.anonymizedAt ? <p className="mt-1 text-sm text-stone">{format(t.anonymizedOn, { date: formatDate(g.anonymizedAt.toISOString().slice(0, 10), lang) })}</p> : null}
      <div className="mt-4 space-y-2">
        {sp.done ? <SuccessNote>{t.saved}</SuccessNote> : null}
        <ErrorNote>{error}</ErrorNote>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-5">
        {[
          [t.stays, String(stats.stays)],
          [t.nights, String(stats.nights)],
          [t.spend, formatMoney(stats.spend, lang)],
          [t.upcomingLabel, String(stats.upcoming)],
          [t.lastStay, stats.lastStay ? formatDate(stats.lastStay, lang, { day: "numeric", month: "short", year: "numeric" }) : "—"],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-line bg-white/70 px-4 py-3">
            <dt className="text-xs text-stone">{label}</dt>
            <dd className="mt-1 font-display text-xl text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Section id="profile" title={t.profileTitle}>
          {g.anonymizedAt ? (
            <p className="text-sm text-stone">{t.anonymizedHint}</p>
          ) : may("guest.edit") ? (
            <form action={updateGuestAction} className="space-y-3">
              {hidden("profile")}
              <label className="block space-y-1 text-xs text-stone">
                <span>{t.name}</span>
                <input name="fullName" required maxLength={120} defaultValue={g.fullName} className={input} />
              </label>
              <div className="grid gap-3 sm:grid-cols-[2fr_2fr_1fr]">
                <label className="space-y-1 text-xs text-stone">
                  <span>{t.email}</span>
                  <input name="email" type="email" maxLength={200} defaultValue={g.email ?? ""} className={input} />
                </label>
                <label className="space-y-1 text-xs text-stone">
                  <span>{t.phone}</span>
                  <input name="phone" maxLength={40} defaultValue={g.phone ?? ""} className={input} />
                </label>
                <label className="space-y-1 text-xs text-stone">
                  <span>{t.country}</span>
                  <input name="country" maxLength={2} defaultValue={g.countryCode ?? ""} className={`${input} uppercase`} />
                </label>
              </div>
              <fieldset className="space-y-1 text-xs text-stone">
                <legend>{t.tag}</legend>
                <div className="flex flex-wrap gap-4 pt-1">
                  {GUEST_TAGS.map((x) => (
                    <label key={x} className="flex items-center gap-2 text-sm text-ink">
                      <input type="checkbox" name="tags" value={x} defaultChecked={g.tags.includes(x)} className="h-4 w-4 accent-lagoon" />
                      {t.tags[x]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="block space-y-1 text-xs text-stone">
                <span>{t.notes}</span>
                <textarea name="notes" rows={4} maxLength={2000} defaultValue={g.notes ?? ""} placeholder={t.notesPlaceholder} className={input} />
              </label>
              <p className="text-xs text-stone">{t.notesHint}</p>
              <button type="submit" className={button}>
                {t.save}
              </button>
            </form>
          ) : (
            <dl className="space-y-1 text-sm">
              <div>{g.email ?? "—"}</div>
              <div>{g.phone ?? "—"}</div>
              {g.notes ? <p className="whitespace-pre-line rounded-lg bg-sand px-3 py-2">{g.notes}</p> : null}
            </dl>
          )}
        </Section>

        <div className="space-y-6">
          {mergeCandidates.length ? (
            <Section id="duplicates" title={t.duplicatesTitle} intro={t.duplicatesIntro}>
              <ul className="divide-y divide-line text-sm">
                {mergeCandidates.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                    <span>
                      <Link href={`/${lang}/ops/guests/${d.id}`} className="font-medium text-lagoon hover:underline">
                        {d.fullName}
                      </Link>
                      <span className="block text-xs text-stone">{[d.email, d.phone].filter(Boolean).join(" · ") || "—"}</span>
                    </span>
                    <form action={mergeGuestAction}>
                      {hidden("duplicates")}
                      <input type="hidden" name="removeId" value={d.id} />
                      <button type="submit" className="rounded-lg border border-lagoon px-3 py-1.5 text-xs text-lagoon hover:bg-lagoon-soft">
                        {t.mergeHere}
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section id="bookings" title={t.bookingsTitle}>
            {bookings.length ? (
              <ul className="divide-y divide-line text-sm">
                {bookings.map(({ r, unitCode, propertyName }) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <Link href={`/${lang}/ops/reservations/${r.code}`} className="font-mono text-lagoon hover:underline">
                        {r.code}
                      </Link>
                      <span className="block text-xs text-stone">
                        {formatDateRange(r.checkIn, r.checkOut, lang)} · {unitCode} · {propertyName}
                      </span>
                    </span>
                    <span className="text-right text-xs">
                      {statuses[r.status] ?? r.status}
                      <span className="block text-ink">{formatMoney(r.totalAmount, lang)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-stone">{t.noBookings}</p>
            )}
          </Section>

          {may("guest.privacy") && !g.anonymizedAt ? (
            <Section id="privacy" title={t.privacyTitle} intro={t.privacyIntro}>
              <a href={`/api/ops/guests/${g.id}/export`} className="inline-block rounded-lg border border-lagoon px-4 py-2 text-sm text-lagoon hover:bg-lagoon-soft">
                {t.exportData}
              </a>
              <form action={anonymizeGuestAction} className="mt-4 space-y-2 rounded-xl border border-danger/40 bg-danger/5 p-4">
                {hidden("privacy")}
                <label className="flex items-start gap-2 text-sm text-ink">
                  <input type="checkbox" name="confirm" required className="mt-1 h-4 w-4 accent-danger" />
                  <span>{t.anonymizeConfirm}</span>
                </label>
                <button type="submit" className="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-ivory hover:opacity-90">
                  {t.anonymize}
                </button>
              </form>
            </Section>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 rounded-xl border border-line bg-white/70 p-5">
      <h2 className="font-display text-xl text-lagoon">{title}</h2>
      {intro ? <p className="mt-1 text-sm text-stone">{intro}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}
