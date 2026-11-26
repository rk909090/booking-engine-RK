import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AuthCard, SuccessNote } from "@/components/ui";
import { hasLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { currentAccessSettings, requireStaff } from "@/lib/auth/current-staff";
import { TwoFactorDisable } from "@/app/[lang]/ops/_components/two-factor-disable";
import { TwoFactorSetup } from "@/app/[lang]/ops/_components/two-factor-setup";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/security">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).security.title };
}

export default async function SecurityPage({ params, searchParams }: PageProps<"/[lang]/ops/security">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);

  return (
    <AuthCard eyebrow={dict.ops.security} title={dict.security.title} intro={dict.security.intro} homeHref={`/${lang}`}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <SecurityContent lang={lang} dict={dict} searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}

async function SecurityContent({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang, { allowWithoutTwoFactor: true });
  const [{ twoFactorRequired }, sp] = await Promise.all([currentAccessSettings(), searchParams]);
  const t = dict.security;
  // Plain link on purpose: a full load avoids reusing a router-cached
  // "go to 2FA setup" redirect from before enrollment.
  const toDashboard = (
    <a href={`/${lang}/ops`} className="block rounded-lg bg-lagoon px-4 py-2.5 text-center font-medium text-ivory hover:bg-lagoon-deep">
      {t.toDashboard}
    </a>
  );
  const policy = (
    <p className="rounded-lg bg-sand/60 px-3 py-2 text-sm text-ink">{twoFactorRequired ? t.required : staff.twoFactorEnabled ? t.optionalEnabled : t.optional}</p>
  );

  // Demo accounts have no password, so they cannot set up an authenticator.
  if (staff.isDemo) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-ink">{t.demoAccount}</p>
        {toDashboard}
      </div>
    );
  }
  if (staff.twoFactorEnabled) {
    return (
      <div className="space-y-4">
        <SuccessNote>{t.enabled}</SuccessNote>
        {policy}
        {toDashboard}
        {twoFactorRequired ? null : <TwoFactorDisable lang={lang} t={t} authT={dict.auth} />}
      </div>
    );
  }
  if (twoFactorRequired) return <TwoFactorSetup lang={lang} t={t} authT={dict.auth} />;
  return (
    <div className="space-y-4">
      {sp.disabled ? <SuccessNote>{t.disabled}</SuccessNote> : null}
      {policy}
      {toDashboard}
      <div className="border-t border-line pt-4">
        <p className="mb-3 text-sm font-semibold text-ink">{t.setupOptional}</p>
        <TwoFactorSetup lang={lang} t={t} authT={dict.auth} />
      </div>
    </div>
  );
}
