import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { hasLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { GuestProfile } from "./detail";

type Props = PageProps<"/[lang]/ops/guests/[id]">;

export async function generateMetadata(): Promise<Metadata> {
  const lang = await rootLang();
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).guests.profileTitle, robots: { index: false } };
}

export default async function GuestProfilePage({ params, searchParams }: Props) {
  const lang = await rootLang();
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <div className="@container">
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Profile lang={lang} dict={dict} params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Profile({ lang, dict, params, searchParams }: { lang: Locale; dict: Dictionary; params: Props["params"]; searchParams: Props["searchParams"] }) {
  const { id } = await params;
  return <GuestProfile lang={lang} dict={dict} id={id} searchParams={searchParams} />;
}
