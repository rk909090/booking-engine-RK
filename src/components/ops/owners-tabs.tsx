import Link from "next/link";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";

export type OwnersTab = "statements" | "setup" | "expenses";
const PATHS: Record<OwnersTab, string> = { statements: "owners", setup: "owners/setup", expenses: "owners/expenses" };

/** Tabs of the owners area (only those the staff member may open), a property switch and a month picker. */
export function OwnersTabs({
  lang,
  dict,
  current,
  tabs,
  property,
  properties,
  month,
}: {
  lang: Locale;
  dict: Dictionary;
  current: OwnersTab;
  tabs: OwnersTab[];
  property: string;
  properties: Array<{ slug: string; name: string }>;
  month?: string;
}) {
  const t = dict.owners;
  const qs = (slug: string) => `?property=${encodeURIComponent(slug)}${month ? `&month=${month}` : ""}`;
  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line">
        <nav aria-label={t.title} className="flex gap-1">
          {tabs.map((key) => (
            <Link
              key={key}
              href={`/${lang}/ops/${PATHS[key]}${qs(property)}`}
              aria-current={key === current ? "page" : undefined}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${key === current ? "border-lagoon font-medium text-lagoon" : "border-transparent text-stone hover:text-ink"}`}
            >
              {t.tabs[key]}
            </Link>
          ))}
        </nav>
        {properties.length > 1 ? (
          <div className="flex flex-wrap gap-2 pb-2 text-sm">
            {properties.map((p) => (
              <Link
                key={p.slug}
                href={`/${lang}/ops/${PATHS[current]}${qs(p.slug)}`}
                aria-current={p.slug === property ? "true" : undefined}
                className={`rounded-full border px-3 py-1 ${p.slug === property ? "border-lagoon bg-lagoon text-ivory" : "border-line text-ink hover:border-lagoon"}`}
              >
                {p.name}
              </Link>
            ))}
          </div>
        ) : null}
      </div>
      {month ? (
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="property" value={property} />
          <label className="space-y-1 text-xs text-stone">
            <span className="block">{t.month}</span>
            <input type="month" name="month" defaultValue={month} required className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink" />
          </label>
          <button type="submit" className="rounded-lg border border-lagoon px-4 py-2 text-sm text-lagoon hover:bg-lagoon-soft">
            {t.show}
          </button>
        </form>
      ) : null}
    </div>
  );
}

/** The month before today's ("2026-10" when today is in November 2026): the one usually being closed. */
export function previousMonth(today: string): string {
  const [y, m] = today.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
