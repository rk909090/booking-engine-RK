import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Card, PageHeader } from "@/components/ops/ui";
import { hasLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/get-dictionary";
import { Invite } from "./invite";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/users/new">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).users.inviteForm.title };
}

export default async function InvitePage({ params }: PageProps<"/[lang]/ops/users/new">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={dict.users.inviteForm.title} />
      <Card>
        <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
          <Invite lang={lang} dict={dict} />
        </Suspense>
      </Card>
    </div>
  );
}
