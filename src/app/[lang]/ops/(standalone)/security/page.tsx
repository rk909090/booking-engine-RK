import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AuthCard, SuccessNote } from "@/components/ui";
import { hasLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { TwoFactorSetup } from "@/app/[lang]/ops/_components/two-factor-setup";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/security">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).security.title };
}

export default async function SecurityPage({ params }: PageProps<"/[lang]/ops/security">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);

  return (
    <AuthCard eyebrow={dict.ops.security} title={dict.security.title} intro={dict.security.intro} homeHref={`/${lang}`}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <SecurityContent lang={lang} dict={dict} />
      </Suspense>
    </AuthCard>
  );
}

async function SecurityContent({ lang, dict }: { lang: Locale; dict: Dictionary }) {
  const staff = await requireStaff(lang, { allowWithoutTwoFactor: true });
  if (staff.twoFactorEnabled) {
    return (
      <div className="space-y-4">
        <SuccessNote>{dict.security.enabled}</SuccessNote>
        {/* Plain link on purpose: a full load avoids reusing a router-cached
            "go to 2FA setup" redirect from before enrollment. */}
        <a
          href={`/${lang}/ops`}
          className="block rounded-lg bg-lagoon px-4 py-2.5 text-center font-medium text-ivory hover:bg-lagoon-deep"
        >
          {dict.security.toDashboard}
        </a>
      </div>
    );
  }
  return <TwoFactorSetup lang={lang} t={dict.security} authT={dict.auth} />;
}
