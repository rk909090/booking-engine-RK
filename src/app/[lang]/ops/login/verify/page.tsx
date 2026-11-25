import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AuthCard } from "@/components/ui";
import { hasLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/get-dictionary";
import { VerifyForm } from "../../_components/verify-form";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/login/verify">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).auth.verifyTitle };
}

export default async function VerifyPage({ params }: PageProps<"/[lang]/ops/login/verify">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const t = (await getDictionary(lang)).auth;

  return (
    <AuthCard eyebrow={t.staffArea} title={t.verifyTitle} intro={t.verifyIntro} homeHref={`/${lang}`}>
      <VerifyForm lang={lang} t={t} />
    </AuthCard>
  );
}
