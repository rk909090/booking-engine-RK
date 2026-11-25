import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { brand } from "@/config/brand";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";
import { LanguageSwitch } from "./language-switch";

/** Header and footer for the guest-facing pages. */
export function SiteShell({ lang, dict, children }: { lang: Locale; dict: Dictionary; children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        {dict.nav.skip}
      </a>
      <header className="border-b border-line bg-ivory/90">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link href={`/${lang}`} className="font-display text-xl text-lagoon">
            {brand.name}
          </Link>
          <div className="flex items-center gap-3 sm:gap-5">
            <Link href={`/${lang}/stay`} className="hidden text-sm text-ink hover:text-lagoon sm:inline">
              {dict.nav.villas}
            </Link>
            <Link href={`/${lang}/booking`} className="text-sm text-ink hover:text-lagoon">
              {dict.nav.findBooking}
            </Link>
            <Suspense fallback={<span className="w-16" />}>
              <LanguageSwitch lang={lang} label={dict.language.label} />
            </Suspense>
          </div>
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="border-t border-line bg-sand/50">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-stone sm:flex-row sm:justify-between sm:px-6">
          <p>
            <span className="font-display text-lagoon">{brand.name}</span> · {dict.footer.tagline}
          </p>
          <p className="flex gap-4">
            <span>{dict.footer.demo}</span>
            <Link href={`/${lang}/ops/login`} className="hover:text-lagoon">
              {dict.nav.staff}
            </Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
