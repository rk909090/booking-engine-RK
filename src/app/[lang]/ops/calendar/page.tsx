import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { OpsNav, OpsShell, NoAccess } from "@/components/ops/ops-shell";
import { addDays, isIsoDate, todayIn } from "@/domain/dates";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
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
  const canModify = data.property ? can(staff.actor, "reservation.modify", data.property.id).allowed : false;
  const canMove = data.property ? can(staff.actor, "reservation.move", data.property.id).allowed : false;

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
      />
    </>
  );
}
