"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { locales, type Locale } from "@/i18n/config";

/** Swaps the locale segment of the current URL, keeping the rest of the path and query. */
export function LanguageSwitch({ lang, label }: { lang: Locale; label: string }) {
  const pathname = usePathname();
  const query = useSearchParams().toString();
  return (
    <nav aria-label={label} className="flex gap-1 text-sm">
      {locales.map((l) => {
        const rest = pathname.split("/").slice(2).join("/");
        const href = `/${l}${rest ? `/${rest}` : ""}${query ? `?${query}` : ""}`;
        return (
          <Link
            key={l}
            href={href}
            hrefLang={l}
            aria-current={l === lang ? "page" : undefined}
            className={l === lang ? "rounded bg-lagoon px-2.5 py-1 text-ivory" : "rounded px-2.5 py-1 text-stone hover:bg-sand"}
          >
            {l.toUpperCase()}
          </Link>
        );
      })}
    </nav>
  );
}
