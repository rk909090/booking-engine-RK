import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { InvoiceDocument } from "@/components/folio/invoice-document";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { invoiceData } from "@/domain/folio";
import { hasLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { verifyBookingAccessToken } from "@/lib/booking/access";

type Props = PageProps<"/[lang]/booking/[code]/invoice">;

export async function generateMetadata(): Promise<Metadata> {
  // The URL carries an access token: keep it out of referrers and search engines.
  return { title: "Invoice", referrer: "no-referrer", robots: { index: false } };
}

export default async function GuestInvoicePage({ params, searchParams }: Props) {
  const lang = await rootLang();
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="p-6 text-sm text-stone">{dict.ops.loading}</p>}>
      <GuestInvoice lang={lang} dict={dict} params={params} searchParams={searchParams} />
    </Suspense>
  );
}

/** The guest's own invoice, once issued. Invoices of other parties are not shown here. */
async function GuestInvoice({ lang, dict, params, searchParams }: { lang: Locale; dict: Dictionary; params: Props["params"]; searchParams: Props["searchParams"] }) {
  const [{ code }, sp] = await Promise.all([params, searchParams]);
  const token = typeof sp.t === "string" ? sp.t : null;
  if (!verifyBookingAccessToken(code, token)) notFound();
  const [r] = await getDb().select({ id: schema.reservations.id }).from(schema.reservations).where(eq(schema.reservations.code, code)).limit(1);
  if (!r) notFound();
  const data = await invoiceData(getDb(), { reservationId: r.id, partyId: null });
  if (!data?.invoice) notFound();
  return (
    <InvoiceDocument
      lang={lang}
      dict={dict}
      data={data}
      toolbar={
        <Link href={`/${lang}/booking/${code}?t=${token}`} className="text-sm text-lagoon hover:underline">
          ← {dict.invoice.backToBooking}
        </Link>
      }
    />
  );
}
