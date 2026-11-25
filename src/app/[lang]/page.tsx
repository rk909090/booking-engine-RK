import Link from "next/link";
import { notFound } from "next/navigation";
import { brand } from "@/config/brand";
import { hasLocale, locales } from "@/i18n/config";
import { getDictionary } from "@/i18n/get-dictionary";

export default async function HomePage({ params }: PageProps<"/[lang]">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-line px-6 py-5 sm:px-10">
        <span className="font-display text-xl tracking-wide text-lagoon">{brand.name}</span>
        <nav aria-label={dict.language.label} className="flex gap-1 text-sm">
          {locales.map((l) => (
            <Link
              key={l}
              href={`/${l}`}
              hrefLang={l}
              aria-current={l === lang ? "page" : undefined}
              className={
                l === lang
                  ? "rounded bg-lagoon px-3 py-1.5 text-ivory"
                  : "rounded px-3 py-1.5 text-stone hover:bg-sand"
              }
            >
              <span className="sm:hidden" aria-hidden="true">
                {l.toUpperCase()}
              </span>
              <span className="sr-only sm:not-sr-only">{dict.language[l]}</span>
            </Link>
          ))}
        </nav>
      </header>

      <section className="flex flex-1 flex-col justify-center px-6 py-16 sm:px-10">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-terracotta-deep">
            {dict.home.eyebrow}
          </p>
          <h1 className="mt-4 font-display text-4xl leading-tight text-lagoon sm:text-6xl">
            {dict.home.title}
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-stone">{dict.home.intro}</p>
          <p className="mt-10 inline-flex items-center gap-2 rounded-full border border-line bg-sand px-4 py-1.5 text-sm text-ink">
            <span className="font-semibold">{dict.home.statusLabel}:</span> {dict.home.status}
          </p>
        </div>
      </section>
    </main>
  );
}
