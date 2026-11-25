import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { OpsNav, OpsShell } from "@/components/ops/ops-shell";
import { addDays, diffDays, isIsoDate, todayIn } from "@/domain/dates";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { authorize } from "@/lib/authz/permissions";
import { calendarData, visibleProperties } from "@/lib/ops/queries";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/calendar">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).opsCalendar.title };
}

export default async function OpsCalendarPage({ params, searchParams }: PageProps<"/[lang]/ops/calendar">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <OpsShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <TapeChart lang={lang} dict={dict} searchParams={searchParams} />
      </Suspense>
    </OpsShell>
  );
}

function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

const barTone: Record<string, string> = {
  hold: "bg-sand text-terracotta-deep border-terracotta/40 border-dashed",
  confirmed: "bg-lagoon-soft text-lagoon border-lagoon/30",
  in_house: "bg-lagoon text-ivory border-lagoon",
  checked_out: "bg-line text-stone border-line",
};

async function TapeChart({
  lang,
  dict,
  searchParams,
}: {
  lang: Locale;
  dict: Dictionary;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const staff = await requireStaff(lang);
  authorize(staff.actor, "calendar.view");
  const sp = await searchParams;
  const t = dict.opsCalendar;
  const span = one(sp.days) === "30" ? 30 : 14;
  const requestedFrom = one(sp.from);
  const now = new Date();

  const visible = await visibleProperties(staff.actor);
  const chosen = visible.find((p) => p.slug === one(sp.property)) ?? visible[0];
  const today = todayIn(chosen?.timezone ?? "Asia/Makassar", now);
  const from = requestedFrom && isIsoDate(requestedFrom) ? requestedFrom : addDays(today, -1);
  const to = addDays(from, span);
  const data = await calendarData(staff.actor, chosen?.slug, from, to, now);
  const days = Array.from({ length: span }, (_, i) => addDays(from, i));
  const link = (overrides: Record<string, string>) => {
    const qs = new URLSearchParams({ property: data.property?.slug ?? "", from, days: String(span), ...overrides });
    return `/${lang}/ops/calendar?${qs}`;
  };
  const columns = `minmax(140px, 180px) repeat(${span}, minmax(44px, 1fr))`;

  return (
    <>
      <OpsNav lang={lang} dict={dict} staff={staff} current="calendar" />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl text-lagoon">{t.title}</h1>
          <p className="mt-1 text-sm text-stone">{t.intro}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {data.properties.length > 1
            ? data.properties.map((p) => (
                <Link
                  key={p.slug}
                  href={link({ property: p.slug })}
                  aria-current={p.slug === data.property?.slug ? "page" : undefined}
                  className={p.slug === data.property?.slug ? "rounded-lg bg-lagoon px-3 py-1.5 text-ivory" : "rounded-lg border border-line px-3 py-1.5 text-ink hover:bg-sand"}
                >
                  {p.name}
                </Link>
              ))
            : null}
          <Link href={link({ from: addDays(from, -span) })} className="rounded-lg border border-line px-3 py-1.5 text-ink hover:bg-sand">
            ← {t.prev}
          </Link>
          <Link href={link({ from: addDays(today, -1) })} className="rounded-lg border border-line px-3 py-1.5 text-ink hover:bg-sand">
            {t.today}
          </Link>
          <Link href={link({ from: addDays(from, span) })} className="rounded-lg border border-line px-3 py-1.5 text-ink hover:bg-sand">
            {t.next} →
          </Link>
          {[14, 30].map((n) => (
            <Link
              key={n}
              href={link({ days: String(n) })}
              aria-current={n === span ? "page" : undefined}
              className={n === span ? "rounded-lg bg-lagoon px-3 py-1.5 text-ivory" : "rounded-lg border border-line px-3 py-1.5 text-ink hover:bg-sand"}
            >
              {format(t.days, { count: n })}
            </Link>
          ))}
        </div>
      </div>

      <div className="mt-5 overflow-x-auto rounded-xl border border-line bg-white/70">
        <div className="grid text-xs" style={{ gridTemplateColumns: columns, minWidth: 180 + span * 44 }}>
          <div className="sticky left-0 z-10 border-b border-r border-line bg-white px-3 py-2 font-medium text-stone">{t.unit}</div>
          {days.map((d) => (
            <div
              key={d}
              className={`border-b border-line px-1 py-2 text-center ${d === today ? "bg-terracotta/10 font-semibold text-terracotta-deep" : "text-stone"}`}
            >
              {formatDate(d, lang, { weekday: "short" })}
              <span className="block text-sm text-ink">{Number(d.slice(8))}</span>
            </div>
          ))}

          {data.units.map((u, row) => {
            const gridRow = row + 2;
            return [
              <div key={`${u.id}-label`} className="sticky left-0 z-10 border-b border-r border-line bg-white px-3 py-2" style={{ gridRow, gridColumn: 1 }}>
                <span className="block text-sm text-ink">{u.name}</span>
                <span className="font-mono text-[11px] text-stone">{u.code}</span>
              </div>,
              ...days.map((d, i) => (
                <div
                  key={`${u.id}-${d}`}
                  className={`border-b border-line/60 ${d === today ? "bg-terracotta/5" : ""}`}
                  style={{ gridRow, gridColumn: i + 2 }}
                />
              )),
              ...data.stays
                .filter((s) => s.unitId === u.id)
                .map((s) => {
                  const start = Math.max(0, diffDays(from, s.checkIn));
                  const end = Math.min(span, diffDays(from, s.checkOut));
                  if (end <= start) return null;
                  return (
                    <Link
                      key={s.code}
                      href={`/${lang}/ops/reservations/${s.code}`}
                      title={`${s.guestName} · ${s.code} · ${dict.booking.status[s.status]}`}
                      className={`z-0 mx-0.5 my-1.5 truncate rounded-md border px-2 py-1 text-[11px] leading-tight hover:brightness-95 ${barTone[s.status] ?? barTone.confirmed}`}
                      style={{ gridRow, gridColumn: `${start + 2} / ${end + 2}` }}
                    >
                      <span className="font-medium">{s.guestName}</span>
                      <span className="block opacity-80">{dict.booking.status[s.status]}</span>
                    </Link>
                  );
                }),
            ];
          })}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-stone" aria-label={t.legend}>
        {(["hold", "confirmed", "in_house", "checked_out"] as const).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={`inline-block h-3 w-5 rounded border ${barTone[s]}`} /> {dict.booking.status[s]}
          </span>
        ))}
      </div>
    </>
  );
}
