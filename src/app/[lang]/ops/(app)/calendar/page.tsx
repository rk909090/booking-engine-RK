import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/ops/ops-shell";
import { addDays, diffDays, isIsoDate, todayIn } from "@/domain/dates";
import { filterClass, PageHeader, secondaryButton } from "@/components/ops/ui";
import { PropertyPicker } from "@/components/ops/property-picker";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { calendarData, visibleProperties } from "@/lib/ops/queries";
import { TapeChartBoard } from "@/components/ops/tape-chart-board";

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
    <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
      <TapeChart lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** Longest range the calendar shows at once. */
const MAX_DAYS = 90;

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
  if (!can(staff.actor, "calendar.view").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const sp = await searchParams;
  const t = dict.opsCalendar;
  const now = new Date();

  const visible = await visibleProperties(staff.actor);
  const chosen = visible.find((p) => p.slug === one(sp.property)) ?? visible[0];
  const today = todayIn(chosen?.timezone ?? "Asia/Makassar", now);
  // The range: a start date and a number of days (from a preset or a custom from–to), at most MAX_DAYS.
  const requestedFrom = one(sp.from);
  const from = requestedFrom && isIsoDate(requestedFrom) ? requestedFrom : addDays(today, -1);
  const requestedTo = one(sp.to);
  const toValid = requestedTo && isIsoDate(requestedTo) ? requestedTo : null;
  const rawDays = toValid ? diffDays(from, toValid) + 1 : Number(one(sp.days)) || 14;
  const invalid = Boolean(toValid && rawDays < 1);
  const span = Math.min(MAX_DAYS, Math.max(1, invalid ? 14 : rawDays));
  const capped = rawDays > MAX_DAYS;
  const to = addDays(from, span);
  const data = await calendarData(staff.actor, chosen?.slug, from, to, now);
  const days = Array.from({ length: span }, (_, i) => addDays(from, i));
  const link = (overrides: Record<string, string>) => {
    const qs = new URLSearchParams({ property: data.property?.slug ?? "", from, days: String(span), ...overrides });
    return `/${lang}/ops/calendar?${qs}`;
  };
  const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
  const monthDays = (first: string) => diffDays(first, `${addDays(first, 32).slice(0, 7)}-01`);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = addDays(today, -((weekday + 6) % 7));
  const nextMonthStart = monthStart(addDays(monthStart(today), 32));
  const presets: Array<{ key: string; label: string; from: string; days: number }> = [
    ...[7, 14, 30, 60, 90].map((n) => ({ key: `d${n}`, label: format(t.days, { count: n }), from, days: n })),
    { key: "week", label: t.range.thisWeek, from: monday, days: 7 },
    { key: "month", label: t.range.thisMonth, from: monthStart(today), days: monthDays(monthStart(today)) },
    { key: "next", label: t.range.nextMonth, from: nextMonthStart, days: monthDays(nextMonthStart) },
  ];
  const cellWidth = span <= 14 ? 44 : span <= 31 ? 34 : span <= 62 ? 26 : 22;
  const canModify = data.property ? can(staff.actor, "reservation.modify", data.property.id).allowed : false;
  const canMove = data.property ? can(staff.actor, "reservation.move", data.property.id).allowed : false;

  const r = t.range;
  const chip = (active: boolean) => (active ? "rounded-lg bg-lagoon px-3 py-1.5 text-ivory" : "rounded-lg border border-line bg-white px-3 py-1.5 text-ink hover:bg-sand");
  const lastDay = addDays(from, span - 1);

  return (
    <>
      <PageHeader
        title={t.title}
        description={t.intro}
        actions={
          data.properties.length > 1 ? (
            <PropertyPicker label={dict.ops.picker.label} t={dict.ops.picker} options={data.properties.map((p) => ({ href: link({ property: p.slug }), label: p.name, active: p.slug === data.property?.slug, closed: !p.isActive }))} />
          ) : null
        }
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link href={link({ from: addDays(from, -span) })} className={chip(false)}>
          ← {t.prev}
        </Link>
        <Link href={link({ from: addDays(today, -1) })} className={chip(false)}>
          {t.today}
        </Link>
        <Link href={link({ from: addDays(from, span) })} className={chip(false)}>
          {t.next} →
        </Link>
        <span className="mx-1 h-6 w-px bg-line" aria-hidden />
        <nav aria-label={r.label} className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <Link key={p.key} href={link({ from: p.from, days: String(p.days) })} aria-current={p.from === from && p.days === span ? "true" : undefined} className={chip(p.from === from && p.days === span)}>
              {p.label}
            </Link>
          ))}
        </nav>
      </div>
      <Form action={`/${lang}/ops/calendar`} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
        <input type="hidden" name="property" value={data.property?.slug ?? ""} />
        <label className="space-y-1 text-xs text-stone">
          <span className="block">{r.from}</span>
          <input type="date" name="from" defaultValue={from} required className={filterClass} />
        </label>
        <label className="space-y-1 text-xs text-stone">
          <span className="block">{r.to}</span>
          <input type="date" name="to" defaultValue={lastDay} required className={filterClass} />
        </label>
        <button type="submit" className={secondaryButton}>
          {r.apply}
        </button>
        <span className="pb-2 text-xs text-stone">
          {format(r.showing, { from: formatDate(from, lang, { day: "numeric", month: "short", year: "numeric" }), to: formatDate(lastDay, lang, { day: "numeric", month: "short", year: "numeric" }), count: span })}
        </span>
      </Form>
      {capped ? <p className="mt-2 text-xs text-terracotta-deep">{format(r.capped, { max: MAX_DAYS })}</p> : null}
      {invalid ? <p className="mt-2 text-xs text-terracotta-deep">{r.invalid}</p> : null}

      <TapeChartBoard
        lang={lang}
        dict={{ cal: t, sc: dict.stayChange, status: dict.booking.status }}
        from={from}
        days={days}
        today={today}
        units={data.units}
        stays={data.stays}
        blocks={data.blocks}
        canModify={canModify}
        canMove={canMove}
        cellWidth={cellWidth}
      />
    </>
  );
}
