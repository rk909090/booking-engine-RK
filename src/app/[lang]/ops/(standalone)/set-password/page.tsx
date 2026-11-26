import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AuthCard } from "@/components/ui";
import { hasLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/get-dictionary";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/config";
import { SetPasswordForm } from "@/app/[lang]/ops/_components/set-password-form";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/set-password">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  // The page URL carries a one-time token: never send it as a referrer.
  return { title: (await getDictionary(lang)).auth.setPasswordTitle, referrer: "no-referrer" };
}

export default async function SetPasswordPage({ params }: PageProps<"/[lang]/ops/set-password">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const t = (await getDictionary(lang)).auth;

  return (
    <AuthCard eyebrow={t.staffArea} title={t.setPasswordTitle} intro={t.setPasswordIntro} homeHref={`/${lang}`}>
      <Suspense>
        <SetPasswordForm lang={lang} t={t} minLength={PASSWORD_MIN_LENGTH} />
      </Suspense>
    </AuthCard>
  );
}
