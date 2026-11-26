import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { InvoiceDocument } from "@/components/folio/invoice-document";
import { getDb } from "@/db/client";
import { invoiceData } from "@/domain/folio";
import { hasLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { getReservationForStaff } from "@/lib/ops/queries";

type Props = PageProps<"/[lang]/ops/reservations/[code]/invoice">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  return { title: `Invoice ${code.toUpperCase()}`, robots: { index: false } };
}

export default async function StaffInvoicePage({ params, searchParams }: Props) {
  const lang = await rootLang();
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="p-6 text-sm text-stone">{dict.ops.loading}</p>}>
      <StaffInvoice lang={lang} dict={dict} params={params} searchParams={searchParams} />
    </Suspense>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function StaffInvoice({ lang, dict, params, searchParams }: { lang: Locale; dict: Dictionary; params: Props["params"]; searchParams: Props["searchParams"] }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "reservation.view").allowed) notFound();
  const [{ code }, sp] = await Promise.all([params, searchParams]);
  const found = await getReservationForStaff(staff.actor, code);
  if (!found) notFound();
  const party = typeof sp.party === "string" && UUID.test(sp.party) ? sp.party : null;
  const data = await invoiceData(getDb(), { reservationId: found.reservation.id, partyId: party });
  if (!data) notFound();
  return (
    <InvoiceDocument
      lang={lang}
      dict={dict}
      data={data}
      toolbar={
        <Link href={`/${lang}/ops/reservations/${found.reservation.code}`} className="text-sm text-lagoon hover:underline">
          ← {dict.invoice.backToReservation}
        </Link>
      }
    />
  );
}
