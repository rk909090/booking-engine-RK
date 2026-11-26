import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SidePanel } from "@/components/ops/shell/side-panel";
import { hasLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/get-dictionary";
import { Invite } from "../../../users/new/invite";

export async function generateMetadata(): Promise<Metadata> {
  const lang = await rootLang();
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).users.inviteForm.title };
}

/** "Invite user" from the users list: the form opens in the right-hand panel. */
export default async function InvitePanel() {
  const lang = await rootLang();
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <SidePanel title={dict.panel.invite} detailPath={`/${lang}/ops/users/new`} fallbackHref={`/${lang}/ops/users`} labels={{ close: dict.panel.close, openFull: dict.panel.openFull }}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Invite lang={lang} dict={dict} />
      </Suspense>
    </SidePanel>
  );
}
