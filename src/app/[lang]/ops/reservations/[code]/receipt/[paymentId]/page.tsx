import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ReceiptDocument } from "@/components/folio/invoice-document";
import { getDb } from "@/db/client";
import { receiptData } from "@/domain/folio";
import { hasLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { getReservationForStaff } from "@/lib/ops/queries";

type Props = PageProps<"/[lang]/ops/reservations/[code]/receipt/[paymentId]">;

export async function generateMetadata(): Promise<Metadata> {
  return { title: "Receipt", robots: { index: false } };
}

export default async function ReceiptPage({ params }: Props) {
  const lang = await rootLang();
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="p-6 text-sm text-stone">{dict.ops.loading}</p>}>
      <Receipt lang={lang} dict={dict} params={params} />
    </Suspense>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function Receipt({ lang, dict, params }: { lang: Locale; dict: Dictionary; params: Props["params"] }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "reservation.view").allowed) notFound();
  const { code, paymentId } = await params;
  if (!UUID.test(paymentId)) notFound();
  const found = await getReservationForStaff(staff.actor, code);
  if (!found) notFound();
  const data = await receiptData(getDb(), { reservationId: found.reservation.id, paymentId });
  if (!data) notFound();
  return (
    <ReceiptDocument
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
