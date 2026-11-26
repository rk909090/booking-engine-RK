import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { hasLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { ReservationDetail } from "./detail";

type Props = PageProps<"/[lang]/ops/reservations/[code]">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  return { title: code.toUpperCase() };
}

export default async function ReservationDetailPage({ params, searchParams }: Props) {
  const lang = await rootLang();
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <div className="@container">
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Detail lang={lang} dict={dict} params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Detail({ lang, dict, params, searchParams }: { lang: Locale; dict: Dictionary; params: Props["params"]; searchParams: Props["searchParams"] }) {
  const { code } = await params;
  return <ReservationDetail lang={lang} dict={dict} code={code} searchParams={searchParams} />;
}
