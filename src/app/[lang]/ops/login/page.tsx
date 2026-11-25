import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AuthCard } from "@/components/ui";
import { hasLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/get-dictionary";
import { LoginForm } from "../_components/login-form";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/login">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).auth.loginTitle };
}

export default async function LoginPage({ params }: PageProps<"/[lang]/ops/login">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const t = (await getDictionary(lang)).auth;

  return (
    <AuthCard eyebrow={t.staffArea} title={t.loginTitle} intro={t.loginIntro} homeHref={`/${lang}`}>
      {/* The form reads ?error=..., which is only known at request time. */}
      <Suspense>
        <LoginForm lang={lang} t={t} />
      </Suspense>
    </AuthCard>
  );
}
