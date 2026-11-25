"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { addDays, eachNight } from "@/domain/dates";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate } from "@/i18n/formatters";
import type { Dictionary } from "@/i18n/get-dictionary";

type Day = { date: string; free: number };

/**
 * Two-click range picker over real availability: first click is check-in,
 * second is check-out. A range is only accepted when every night in it has
 * a free villa. Shows one month at a time.
 */
export function BookingCalendar({
  lang,
  t,
  searchT,
  days,
  unitTypeId,
  minStayNights,
  maxGuests,
  initial,
}: {
  lang: Locale;
  t: Dictionary["villa"];
  searchT: Dictionary["search"];
  days: Day[];
  unitTypeId: string;
  minStayNights: number;
  maxGuests: number;
  initial: { checkIn?: string; checkOut?: string; adults: number; children: number };
}) {
  const freeByDate = useMemo(() => new Map(days.map((d) => [d.date, d.free])), [days]);
  const first = days[0]?.date ?? "";
  const last = days.at(-1)?.date ?? "";
  const months = useMemo(() => [...new Set(days.map((d) => d.date.slice(0, 7)))], [days]);

  const [monthIndex, setMonthIndex] = useState(0);
  const [checkIn, setCheckIn] = useState<string | undefined>(initial.checkIn);
  const [checkOut, setCheckOut] = useState<string | undefined>(initial.checkOut);
  const [adults, setAdults] = useState(initial.adults);
  const [children, setChildren] = useState(initial.children);

  const nightsFree = (from: string, to: string) => eachNight(from, to).every((d) => (freeByDate.get(d) ?? 0) > 0);

  function pick(date: string) {
    if (!checkIn || checkOut || date <= checkIn) {
      if ((freeByDate.get(date) ?? 0) > 0) {
        setCheckIn(date);
        setCheckOut(undefined);
      }
      return;
    }
    if (nightsFree(checkIn, date)) setCheckOut(date);
  }

  const month = months[monthIndex];
  const cells = useMemo(() => {
    if (!month) return [];
    const startDate = `${month}-01`;
    const offset = (new Date(`${startDate}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday first
    const list: Array<string | null> = Array.from({ length: offset }, () => null);
    for (let d = startDate; d.startsWith(month); d = addDays(d, 1)) list.push(d);
    return list;
  }, [month]);

  const weekdays = Array.from({ length: 7 }, (_, i) => formatDate(addDays("2027-02-01", i), lang, { weekday: "narrow" }));
  const nights = checkIn && checkOut ? eachNight(checkIn, checkOut).length : 0;
  const tooShort = nights > 0 && nights < minStayNights;
  const guestsOk = adults + children <= maxGuests;
  const ready = checkIn && checkOut && !tooShort && guestsOk;
  const bookHref = ready
    ? `/${lang}/book?${new URLSearchParams({ unitType: unitTypeId, checkIn, checkOut, adults: String(adults), children: String(children) })}`
    : undefined;

  return (
    <div className="rounded-2xl border border-line bg-white/80 p-5">
      <p className="text-sm text-stone">{t.availabilityIntro}</p>
      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setMonthIndex((i) => Math.max(0, i - 1))}
          disabled={monthIndex === 0}
          aria-label={t.prevMonth}
          className="rounded px-2 py-1 text-lagoon disabled:opacity-30"
        >
          ‹
        </button>
        <p className="font-medium text-ink">{month ? formatDate(`${month}-01`, lang, { month: "long", year: "numeric" }) : ""}</p>
        <button
          type="button"
          onClick={() => setMonthIndex((i) => Math.min(months.length - 1, i + 1))}
          disabled={monthIndex >= months.length - 1}
          aria-label={t.nextMonth}
          className="rounded px-2 py-1 text-lagoon disabled:opacity-30"
        >
          ›
        </button>
      </div>
      <div className="mt-3 grid grid-cols-7 gap-1 text-center text-xs text-stone">
        {weekdays.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((date, i) => {
          if (!date) return <span key={`blank-${i}`} />;
          const inRange = date >= first && date <= last;
          const free = freeByDate.get(date) ?? 0;
          const selected = date === checkIn || date === checkOut || (checkIn && checkOut && date > checkIn && date < checkOut);
          // A full night can still be a check-out day for the previous night's stay.
          const clickable = inRange && (free > 0 || (checkIn && !checkOut && date > checkIn));
          return (
            <button
              key={date}
              type="button"
              disabled={!clickable}
              onClick={() => pick(date)}
              aria-pressed={Boolean(selected)}
              aria-label={`${formatDate(date, lang)}${inRange && free === 0 ? ` · ${t.legendFull}` : ""}`}
              className={[
                "aspect-square rounded-lg text-sm",
                selected ? "bg-lagoon text-ivory" : free > 0 && inRange ? "bg-lagoon-soft text-ink hover:bg-sand" : "text-stone/50 line-through",
                clickable ? "" : "cursor-not-allowed",
              ].join(" ")}
            >
              {Number(date.slice(8))}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex gap-4 text-xs text-stone">
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-lagoon-soft" /> {t.legendFree}
        </span>
        <span className="flex items-center gap-1">
          <span className="text-stone/50 line-through">12</span> {t.legendFull}
        </span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <label className="space-y-1 text-sm">
          <span className="font-medium text-ink">{searchT.adults}</span>
          <select value={adults} onChange={(e) => setAdults(Number(e.target.value))} className="w-full rounded-lg border border-line bg-white px-3 py-2">
            {Array.from({ length: maxGuests }, (_, i) => i + 1).map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium text-ink">{searchT.children}</span>
          <select value={children} onChange={(e) => setChildren(Number(e.target.value))} className="w-full rounded-lg border border-line bg-white px-3 py-2">
            {Array.from({ length: maxGuests }, (_, i) => i).map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-4 space-y-2 text-sm" aria-live="polite">
        {checkIn ? (
          <p className="text-ink">
            {format(t.selected, {
              checkIn: formatDate(checkIn, lang),
              checkOut: checkOut ? formatDate(checkOut, lang) : "…",
            })}
            {nights ? ` · ${format(searchT.nights, { count: nights })}` : ""}
          </p>
        ) : null}
        {tooShort ? <p className="text-danger">{format(t.minStay, { count: minStayNights })}</p> : null}
        {!guestsOk ? <p className="text-danger">{format(t.maxGuests, { count: maxGuests })}</p> : null}
      </div>
      <div className="mt-4 flex items-center gap-3">
        {bookHref ? (
          <Link href={bookHref} className="flex-1 rounded-lg bg-lagoon px-4 py-2.5 text-center font-medium text-ivory hover:bg-lagoon-deep">
            {t.book}
          </Link>
        ) : (
          <span className="flex-1 rounded-lg bg-lagoon/40 px-4 py-2.5 text-center font-medium text-ivory">{t.book}</span>
        )}
        {checkIn ? (
          <button
            type="button"
            onClick={() => {
              setCheckIn(undefined);
              setCheckOut(undefined);
            }}
            className="text-sm text-stone underline-offset-4 hover:underline"
          >
            {t.clear}
          </button>
        ) : null}
      </div>
    </div>
  );
}
