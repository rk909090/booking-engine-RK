import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { GuestBadges } from "@/components/ops/guest-badges";
import { GuestsTabs } from "@/components/ops/guests-tabs";
import { NoAccess, OpsNav, OpsShell } from "@/components/ops/ops-shell";
import { getDb } from "@/db/client";
import { GUEST_TAGS, guestStats, listGuests } from "@/domain/guests";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/guests">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).guests.title };
}

export default async function GuestsPage({ params, searchParams }: PageProps<"/[lang]/ops/guests">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <OpsShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Guests lang={lang} dict={dict} searchParams={searchParams} />
      </Suspense>
    </OpsShell>
  );
}

const PAGE = 25;
const input = "rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function Guests({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "guest.view").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const t = dict.guests;
  const sp = await searchParams;
  const q = (one(sp.q) ?? "").slice(0, 100);
  const tagRaw = one(sp.tag) ?? "";
  const tag = (GUEST_TAGS as readonly string[]).includes(tagRaw) ? tagRaw : null;
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const propertyIds = staff.actor.role === "director" ? null : staff.actor.propertyIds;
  const db = getDb();
  const { rows, total } = await listGuests(db, { propertyIds, q, tag, limit: PAGE, offset: (page - 1) * PAGE });
  const stats = await guestStats(db, rows.map((r) => r.guest.id), propertyIds);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const href = (p: number) => `/${lang}/ops/guests?${new URLSearchParams({ ...(q ? { q } : {}), ...(tag ? { tag } : {}), page: String(p) }).toString()}`;
  const day = (d: string) => formatDate(d, lang, { day: "numeric", month: "short", year: "numeric" });

  return (
    <>
      <OpsNav lang={lang} dict={dict} staff={staff} current="guests" />
      <h1 className="font-display text-3xl text-lagoon">{t.title}</h1>
      <p className="mt-1 max-w-3xl text-sm text-stone">{t.intro}</p>
      <GuestsTabs lang={lang} dict={dict} current="list" showApoa={can(staff.actor, "guest.apoa").allowed} />

      <form method="get" className="mt-4 flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs text-stone">
          <span className="block">{t.search}</span>
          <input name="q" defaultValue={q} maxLength={100} placeholder={t.searchPlaceholder} className={`${input} w-72`} />
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span className="block">{t.tag}</span>
          <select name="tag" defaultValue={tag ?? ""} className={input}>
            <option value="">{t.allTags}</option>
            {GUEST_TAGS.map((x) => (
              <option key={x} value={x}>
                {t.tags[x]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
          {t.searchButton}
        </button>
      </form>

      <p className="mt-4 text-sm text-stone">{format(t.count, { count: total })}</p>
      {rows.length ? (
        <div className="mt-2 overflow-x-auto rounded-xl border border-line bg-white/70">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="border-b border-line text-left text-xs text-stone">
              <tr>
                <th className="px-4 py-2 font-normal">{t.name}</th>
                <th className="px-4 py-2 font-normal">{t.contact}</th>
                <th className="px-4 py-2 text-right font-normal">{t.stays}</th>
                <th className="px-4 py-2 text-right font-normal">{t.nights}</th>
                <th className="px-4 py-2 text-right font-normal">{t.spend}</th>
                <th className="px-4 py-2 font-normal">{t.lastStay}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ guest: g }) => {
                const s = stats.get(g.id)!;
                return (
                  <tr key={g.id} className="border-b border-line/60 last:border-0 hover:bg-sand/40">
                    <td className="px-4 py-3">
                      <Link href={`/${lang}/ops/guests/${g.id}`} className="font-medium text-lagoon hover:underline">
                        {g.anonymizedAt ? t.anonymized : g.fullName}
                      </Link>{" "}
                      <GuestBadges dict={dict} tags={g.tags} pastStays={0} />
                    </td>
                    <td className="px-4 py-3 text-xs text-stone">{[g.email, g.phone].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="px-4 py-3 text-right">
                      {s.stays}
                      {s.upcoming ? <span className="block text-xs text-stone">{format(t.upcoming, { count: s.upcoming })}</span> : null}
                    </td>
                    <td className="px-4 py-3 text-right">{s.nights}</td>
                    <td className="px-4 py-3 text-right">{formatMoney(s.spend, lang)}</td>
                    <td className="px-4 py-3">{s.lastStay ? day(s.lastStay) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-4 text-sm text-stone">{t.noGuests}</p>
      )}
      {pages > 1 ? (
        <nav className="mt-4 flex items-center gap-3 text-sm" aria-label={t.pages}>
          {page > 1 ? (
            <Link href={href(page - 1)} className="text-lagoon hover:underline">
              ← {t.previous}
            </Link>
          ) : null}
          <span className="text-stone">{format(t.pageOf, { page, pages })}</span>
          {page < pages ? (
            <Link href={href(page + 1)} className="text-lagoon hover:underline">
              {t.next} →
            </Link>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}
