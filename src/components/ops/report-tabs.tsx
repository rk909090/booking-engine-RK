import Link from "next/link";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";

/** Switches between the period report and the pace (on the books) report, keeping the property. */
export function ReportTabs({ lang, dict, current, property }: { lang: Locale; dict: Dictionary; current: "period" | "pace"; property: string | null }) {
  const qs = property ? `?property=${encodeURIComponent(property)}` : "";
  const tabs = [
    { key: "period", href: `/${lang}/ops/reports${qs}`, label: dict.reports.tabPeriod },
    { key: "pace", href: `/${lang}/ops/reports/pace${qs}`, label: dict.reports.tabPace },
  ] as const;
  return (
    <nav aria-label={dict.reports.title} className="mt-4 flex gap-1 border-b border-line">
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
  );
}
