import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { hasLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { UserDetail } from "./detail";

type Props = PageProps<"/[lang]/ops/users/[id]">;

export async function generateMetadata(): Promise<Metadata> {
  const lang = await rootLang();
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).panel.user };
}

export default async function UserPage({ params, searchParams }: Props) {
  const lang = await rootLang();
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <div className="@container">
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Content lang={lang} dict={dict} params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Content({ lang, dict, params, searchParams }: { lang: Locale; dict: Dictionary; params: Props["params"]; searchParams: Props["searchParams"] }) {
  const { id } = await params;
  return <UserDetail lang={lang} dict={dict} id={id} searchParams={searchParams} />;
}
