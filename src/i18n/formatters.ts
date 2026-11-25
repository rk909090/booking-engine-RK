import type { Locale } from "./config";

const intlLocale: Record<Locale, string> = { id: "id-ID", en: "en-GB" };

export function formatMoney(amount: number, locale: Locale, currency = "IDR"): string {
  return new Intl.NumberFormat(intlLocale[locale], {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

/** Formats an ISO calendar date ("2027-02-10") without time-zone drift. */
export function formatDate(
  isoDate: string,
  locale: Locale,
  options: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric" },
): string {
  return new Intl.DateTimeFormat(intlLocale[locale], { ...options, timeZone: "UTC" }).format(
    new Date(`${isoDate}T00:00:00Z`),
  );
}

export function formatDateRange(checkIn: string, checkOut: string, locale: Locale): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
  return `${formatDate(checkIn, locale, opts)} – ${formatDate(checkOut, locale, opts)}`;
}
