import { asc, eq, inArray } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CopyField } from "@/components/ops/copy-field";
import { NoAccess, OpsNav, OpsShell } from "@/components/ops/ops-shell";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { todayIn } from "@/domain/dates";
import { calendarConflicts, exportToken, SYNC_MINUTES } from "@/domain/ical";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDateRange } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { appUrl } from "@/lib/booking/access";
import { addFeedAction, removeFeedAction, syncFeedAction } from "@/lib/ops/channel-actions";
import { visibleProperties } from "@/lib/ops/queries";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/channels">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).channels.title };
}

export default async function ChannelsPage({ params, searchParams }: PageProps<"/[lang]/ops/channels">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <OpsShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Channels lang={lang} dict={dict} searchParams={searchParams} />
      </Suspense>
    </OpsShell>
  );
}

const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";
/** Shows where a feed points without revealing its secret part. */
const maskUrl = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.host}/…${u.pathname.slice(-6)}`;
  } catch {
    return "…";
  }
};

async function Channels({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "channels.manage").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const t = dict.channels;
  const sp = await searchParams;
  const properties = (await visibleProperties(staff.actor)).filter((p) => can(staff.actor, "channels.manage", p.id).allowed);
  const propertyIds = properties.map((p) => p.id);
  const db = getDb();
  const units = propertyIds.length
    ? await db
        .select({ id: schema.units.id, code: schema.units.code, name: schema.units.name, propertyId: schema.units.propertyId, typeName: schema.unitTypes.name })
        .from(schema.units)
        .innerJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.units.unitTypeId))
        .where(inArray(schema.units.propertyId, propertyIds))
        .orderBy(asc(schema.unitTypes.sortOrder), asc(schema.units.code))
    : [];
  const feeds = units.length
    ? await db.select().from(schema.icalFeeds).where(inArray(schema.icalFeeds.unitId, units.map((u) => u.id))).orderBy(asc(schema.icalFeeds.createdAt))
    : [];
  const tokens = new Map(await Promise.all(units.map(async (u) => [u.id, await exportToken(db, u.id)] as const)));
  const today = todayIn(properties[0]?.timezone ?? "Asia/Makassar");
  const conflicts = await calendarConflicts(db, { propertyIds, today });
  const fmt = new Intl.DateTimeFormat(lang === "id" ? "id-ID" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: properties[0]?.timezone ?? "Asia/Makassar" });
  const done = typeof sp.done === "string" ? (t.done as Record<string, string>)[sp.done] : undefined;
  const error = typeof sp.error === "string" ? ((t.errors as Record<string, string>)[sp.error] ?? t.errors.not_found) : undefined;
  const hidden = (unitId: string) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="unitId" value={unitId} />
    </>
  );

  return (
    <>
      <OpsNav lang={lang} dict={dict} staff={staff} current="channels" />
      <h1 className="font-display text-3xl text-lagoon">{t.title}</h1>
      <p className="mt-1 max-w-3xl text-sm text-stone">{format(t.intro, { minutes: SYNC_MINUTES })}</p>
      <div className="mt-4 space-y-2">
        {done ? <SuccessNote>{done}</SuccessNote> : null}
        <ErrorNote>{error}</ErrorNote>
      </div>

      {conflicts.length ? (
        <section className="mt-6 rounded-xl border border-danger/40 bg-danger/5 p-4" aria-labelledby="conflicts-title">
          <h2 id="conflicts-title" className="font-display text-xl text-danger">
            {format(t.conflictsTitle, { count: conflicts.length })}
          </h2>
          <p className="text-xs text-stone">{t.conflictsHint}</p>
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {conflicts.map((c) => (
              <li key={c.eventId}>
                <span className="font-mono">{c.unitCode}</span> · {c.feedName} · {formatDateRange(c.startDate, c.endDate, lang)} — {t.conflictsWith}{" "}
                {c.codes.map((code, i) => (
                  <span key={code}>
                    {i > 0 ? ", " : ""}
                    <Link href={`/${lang}/ops/reservations/${code}`} className="font-mono text-lagoon hover:underline">
                      {code}
                    </Link>
                  </span>
                ))}
                {c.codes.length && c.otherFeeds.length ? ", " : ""}
                {c.otherFeeds.join(", ")}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <details className="mt-6 rounded-xl border border-line bg-white/70 p-4 text-sm">
        <summary className="cursor-pointer font-medium text-lagoon">{t.howTitle}</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink">
          <li>{t.how1}</li>
          <li>{t.how2}</li>
          <li>{t.how3}</li>
        </ol>
      </details>

      {properties.map((p) => (
        <section key={p.id} className="mt-8">
          <h2 className="font-display text-2xl text-lagoon">{p.name}</h2>
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            {units
              .filter((u) => u.propertyId === p.id)
              .map((u) => {
                const unitFeeds = feeds.filter((f) => f.unitId === u.id);
                return (
                  <article key={u.id} id={`unit-${u.id}`} className="space-y-3 rounded-xl border border-line bg-white/70 p-4">
                    <header>
                      <p className="font-medium text-ink">{u.name}</p>
                      <p className="font-mono text-xs text-stone">
                        {u.code} · {u.typeName}
                      </p>
                    </header>
                    <div className="space-y-1">
                      <p className="text-xs font-semibold uppercase tracking-[0.15em] text-terracotta-deep">{t.exportTitle}</p>
                      <CopyField value={new URL(`/api/ical/${tokens.get(u.id)}.ics`, appUrl()).toString()} copyLabel={dict.resDetail.copy} copiedLabel={dict.resDetail.copied} />
                      <p className="text-xs text-stone">{t.exportHint}</p>
                    </div>
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-[0.15em] text-terracotta-deep">{t.importTitle}</p>
                      {unitFeeds.length === 0 ? <p className="text-xs text-stone">{t.noFeeds}</p> : null}
                      <ul className="space-y-2">
                        {unitFeeds.map((f) => (
                          <li key={f.id} className="rounded-lg border border-line px-3 py-2 text-sm">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-medium text-ink">
                                {f.name} <span className="font-mono text-xs font-normal text-stone">{maskUrl(f.url)}</span>
                              </span>
                              <span className={`text-xs ${f.lastStatus === "error" ? "text-danger" : f.lastStatus === "ok" ? "text-lagoon" : "text-stone"}`}>
                                {f.lastStatus === "error" ? t.statusError : f.lastStatus === "ok" ? format(t.statusOk, { count: f.eventCount }) : t.statusNever}
                              </span>
                            </div>
                            <p className="text-xs text-stone">
                              {f.lastSyncedAt ? format(t.lastSync, { time: fmt.format(f.lastSyncedAt) }) : t.statusNever}
                              {f.lastError ? ` · ${f.lastError}` : ""}
                            </p>
                            <div className="mt-2 flex gap-2">
                              <form action={syncFeedAction}>
                                {hidden(u.id)}
                                <input type="hidden" name="feedId" value={f.id} />
                                <button type="submit" className="rounded-lg border border-line px-3 py-1 text-xs text-ink hover:bg-sand">
                                  {t.syncNow}
                                </button>
                              </form>
                              <form action={removeFeedAction}>
                                {hidden(u.id)}
                                <input type="hidden" name="feedId" value={f.id} />
                                <button type="submit" className="rounded-lg border border-danger/40 px-3 py-1 text-xs text-danger hover:bg-danger/5">
                                  {t.remove}
                                </button>
                              </form>
                            </div>
                          </li>
                        ))}
                      </ul>
                      <form action={addFeedAction} className="grid gap-2 sm:grid-cols-[150px_1fr]">
                        {hidden(u.id)}
                        <label className="space-y-1 text-xs text-stone">
                          <span className="block">{t.name}</span>
                          <input name="name" list="channel-names" required maxLength={60} placeholder="Airbnb" className={input} />
                        </label>
                        <label className="space-y-1 text-xs text-stone">
                          <span className="block">{t.url}</span>
                          <input name="url" type="url" required placeholder="https://www.airbnb.com/calendar/ical/….ics" className={input} />
                        </label>
                        <button type="submit" className="rounded-lg bg-lagoon px-3 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep sm:col-span-2">
                          {t.add}
                        </button>
                      </form>
                    </div>
                  </article>
                );
              })}
          </div>
        </section>
      ))}
      <datalist id="channel-names">
        <option value="Airbnb" />
        <option value="Booking.com" />
        <option value="VRBO" />
        <option value="Agoda" />
      </datalist>
    </>
  );
}
