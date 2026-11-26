import Link from "next/link";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";

/** Switches between the guest list and the immigration (APOA) list. */
export function GuestsTabs({ lang, dict, current, showApoa }: { lang: Locale; dict: Dictionary; current: "list" | "apoa"; showApoa: boolean }) {
  const tabs = [
    { key: "list", href: `/${lang}/ops/guests`, label: dict.guests.tabList },
    ...(showApoa ? [{ key: "apoa", href: `/${lang}/ops/guests/apoa`, label: dict.guests.tabApoa }] : []),
  ];
  return (
    <nav aria-label={dict.guests.title} className="mt-4 flex gap-1 border-b border-line">
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
