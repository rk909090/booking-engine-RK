import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PanelSkeleton, SidePanel } from "@/components/ops/shell/side-panel";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { ReservationDetail } from "../../../reservations/[code]/detail";

type Props = { params: Promise<{ code: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

// Panels have no page underneath them to name the tab.
export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  return { title: (await params).code.toUpperCase() };
}

/** A reservation opened from a list or the home page: shown in the right-hand panel. */
export default async function ReservationPanel({ params, searchParams }: Props) {
  const lang = await rootLang();
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<PanelSkeleton label={dict.ops.loading} />}>
      <Panel lang={lang} dict={dict} params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Panel({ lang, dict, params, searchParams }: Props & { lang: Locale; dict: Dictionary }) {
  const { code } = await params;
  return (
    <SidePanel
      title={format(dict.panel.reservation, { code: code.toUpperCase() })}
      detailPath={`/${lang}/ops/reservations/${code}`}
      fallbackHref={`/${lang}/ops/reservations`}
      labels={{ close: dict.panel.close, openFull: dict.panel.openFull }}
    >
      <ReservationDetail lang={lang} dict={dict} code={code} searchParams={searchParams} inPanel />
    </SidePanel>
  );
}
