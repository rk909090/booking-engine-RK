import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PanelSkeleton, SidePanel } from "@/components/ops/shell/side-panel";
import { hasLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { GuestProfile } from "../../../guests/[id]/detail";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

// Panels have no page underneath them to name the tab.
export async function generateMetadata(): Promise<Metadata> {
  const lang = await rootLang();
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).guests.profileTitle, robots: { index: false } };
}

/** A guest opened from a list or a reservation: shown in the right-hand panel. */
export default async function GuestPanel({ params, searchParams }: Props) {
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
  const { id } = await params;
  return (
    <SidePanel title={dict.panel.guest} detailPath={`/${lang}/ops/guests/${id}`} fallbackHref={`/${lang}/ops/guests`} labels={{ close: dict.panel.close, openFull: dict.panel.openFull }}>
      <GuestProfile lang={lang} dict={dict} id={id} searchParams={searchParams} inPanel />
    </SidePanel>
  );
}
