import Link from "next/link";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";

/** Switches between rate settings and promo codes, keeping the property. */
export function RatesTabs({ lang, dict, current, property, properties }: { lang: Locale; dict: Dictionary; current: "rates" | "promos"; property: string; properties: Array<{ slug: string; name: string }> }) {
  const qs = `?property=${encodeURIComponent(property)}`;
  const tabs = [
    { key: "rates", href: `/${lang}/ops/rates${qs}`, label: dict.rates.tabRates },
    { key: "promos", href: `/${lang}/ops/rates/promos${qs}`, label: dict.rates.tabPromos },
  ] as const;
  const base = current === "rates" ? `/${lang}/ops/rates` : `/${lang}/ops/rates/promos`;
  return (
    <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-b border-line">
      <nav aria-label={dict.rates.title} className="flex gap-1">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={t.key === current ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${t.key === current ? "border-lagoon font-medium text-lagoon" : "border-transparent text-stone hover:text-ink"}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {properties.length > 1 ? (
        <div className="flex flex-wrap gap-2 pb-2 text-sm">
          {properties.map((p) => (
            <Link
              key={p.slug}
              href={`${base}?property=${encodeURIComponent(p.slug)}`}
              aria-current={p.slug === property ? "true" : undefined}
              className={`rounded-full border px-3 py-1 ${p.slug === property ? "border-lagoon bg-lagoon text-ivory" : "border-line text-ink hover:border-lagoon"}`}
            >
              {p.name}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
