import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AuthCard } from "@/components/ui";
import { hasLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/get-dictionary";
import { LookupForm } from "./lookup-form";

export async function generateMetadata({ params }: PageProps<"/[lang]/booking">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).booking.lookupTitle };
}

export default async function BookingLookupPage({ params }: PageProps<"/[lang]/booking">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <AuthCard eyebrow={dict.nav.findBooking} title={dict.booking.lookupTitle} intro={dict.booking.lookupIntro} homeHref={`/${lang}`}>
      <LookupForm lang={lang} t={dict.booking} errors={dict.checkout.errors} />
    </AuthCard>
  );
}
