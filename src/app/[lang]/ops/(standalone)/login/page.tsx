import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AuthCard } from "@/components/ui";
import { hasLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/get-dictionary";
import { DemoLogins } from "@/app/[lang]/ops/_components/demo-logins";
import { LoginForm } from "@/app/[lang]/ops/_components/login-form";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/login">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).auth.loginTitle };
}

export default async function LoginPage({ params }: PageProps<"/[lang]/ops/login">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  const t = dict.auth;

  return (
    <AuthCard eyebrow={t.staffArea} title={t.loginTitle} intro={t.loginIntro} homeHref={`/${lang}`}>
      {/* Demo sign-in buttons, only while a director has them switched on. */}
      <Suspense fallback={null}>
        <DemoLogins lang={lang} dict={dict} />
      </Suspense>
      {/* The form reads ?error=..., which is only known at request time. */}
      <Suspense>
        <LoginForm lang={lang} t={t} />
      </Suspense>
    </AuthCard>
  );
}
