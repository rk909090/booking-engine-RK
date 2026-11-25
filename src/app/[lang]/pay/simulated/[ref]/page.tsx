import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AuthCard } from "@/components/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { hasLocale, type Locale } from "@/i18n/config";
import { formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { approveSimulatedPayment, declineSimulatedPayment } from "@/lib/booking/actions";
import { simulatorEnabled } from "@/lib/payments/provider";

type Props = PageProps<"/[lang]/pay/simulated/[ref]">;

export async function generateMetadata(): Promise<Metadata> {
  const lang = await rootLang();
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).pay.simulatedTitle, robots: { index: false } };
}

export default async function SimulatedPaymentPage({ params }: Props) {
  const lang = await rootLang();
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <AuthCard eyebrow="Simulasi / Simulation" title={dict.pay.simulatedTitle} homeHref={`/${lang}`}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Simulator lang={lang} dict={dict} params={params} />
      </Suspense>
    </AuthCard>
  );
}

async function Simulator({ lang, dict, params }: { lang: Locale; dict: Dictionary; params: Props["params"] }) {
  const t = dict.pay;
  if (!simulatorEnabled()) return <p className="text-stone">{t.disabled}</p>;
  const { ref } = await params;
  const [row] = await getDb()
    .select({ payment: schema.payments, code: schema.reservations.code })
    .from(schema.payments)
    .innerJoin(schema.reservations, eq(schema.reservations.id, schema.payments.reservationId))
    .where(and(eq(schema.payments.provider, "simulated"), eq(schema.payments.providerRef, ref)))
    .limit(1);
  if (!row || row.payment.status !== "pending") return <p className="text-stone">{t.notFound}</p>;

  return (
    <div className="space-y-5">
      <p className="rounded-lg border border-terracotta/40 bg-terracotta/10 px-3 py-2 text-sm text-terracotta-deep">{t.simulatedBanner}</p>
      <dl className="space-y-1 text-sm">
        <div className="flex justify-between">
          <dt className="text-stone">{t.reference}</dt>
          <dd className="font-mono text-ink">{row.code}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-stone">{t.amount}</dt>
          <dd className="font-medium text-ink">{formatMoney(row.payment.amount, lang)}</dd>
        </div>
      </dl>
      <form action={approveSimulatedPayment}>
        <input type="hidden" name="lang" value={lang} />
        <input type="hidden" name="ref" value={ref} />
        <button type="submit" className="w-full rounded-lg bg-lagoon px-4 py-2.5 font-medium text-ivory hover:bg-lagoon-deep">
          {t.approve}
        </button>
      </form>
      <form action={declineSimulatedPayment}>
        <input type="hidden" name="lang" value={lang} />
        <input type="hidden" name="ref" value={ref} />
        <button type="submit" className="w-full rounded-lg border border-line px-4 py-2.5 text-ink hover:bg-sand">
          {t.decline}
        </button>
      </form>
    </div>
  );
}
