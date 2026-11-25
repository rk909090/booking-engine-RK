import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SearchForm } from "@/components/site/search-form";
import { SiteShell } from "@/components/site/site-shell";
import { VillaImage } from "@/components/site/villa-image";
import { hasLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { listProperties } from "@/lib/site/queries";

export default async function HomePage({ params }: PageProps<"/[lang]">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);

  return (
    <SiteShell lang={lang} dict={dict}>
      <section className="bg-lagoon text-ivory">
        <div className="mx-auto max-w-6xl px-4 pb-24 pt-16 sm:px-6 sm:pt-24">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sand">{dict.home.eyebrow}</p>
          <h1 className="mt-4 max-w-3xl font-display text-4xl leading-tight sm:text-6xl">{dict.home.title}</h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ivory/85">{dict.home.intro}</p>
        </div>
      </section>
      <div className="mx-auto -mt-14 max-w-6xl px-4 sm:px-6">
        <Suspense fallback={<SearchForm lang={lang} t={dict.search} properties={[]} />}>
          <HomeSearch lang={lang} dict={dict} />
        </Suspense>
      </div>
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="font-display text-3xl text-lagoon">{dict.home.propertiesTitle}</h2>
        <Suspense fallback={<p className="mt-6 text-stone">{dict.ops.loading}</p>}>
          <PropertyList lang={lang} dict={dict} />
        </Suspense>
      </section>
    </SiteShell>
  );
}

async function HomeSearch({ lang, dict }: { lang: Locale; dict: Dictionary }) {
  const properties = await listProperties();
  return <SearchForm lang={lang} t={dict.search} properties={properties} />;
}

async function PropertyList({ lang, dict }: { lang: Locale; dict: Dictionary }) {
  const properties = await listProperties();
  return (
    <ul className="mt-6 grid gap-6 sm:grid-cols-2">
      {properties.map((p, i) => (
        <li key={p.id} className="overflow-hidden rounded-2xl border border-line bg-white/70">
          <VillaImage className="h-48" palette={i % 2 ? ["#3d6b4f", "#e0c98f"] : ["#2f5d50", "#c9b48a"]} />
          <div className="p-5">
            <h3 className="font-display text-2xl text-lagoon">{p.name}</h3>
            {p.content.tagline ? <p className="mt-1 text-ink">{p.content.tagline[lang]}</p> : null}
            {p.content.location ? <p className="mt-1 text-sm text-stone">{p.content.location[lang]}</p> : null}
            <Link
              href={`/${lang}/stay?property=${p.slug}`}
              className="mt-4 inline-block rounded-lg border border-lagoon px-4 py-2 text-sm font-medium text-lagoon hover:bg-lagoon hover:text-ivory"
            >
              {dict.home.viewVillas}
            </Link>
          </div>
        </li>
      ))}
    </ul>
  );
}
