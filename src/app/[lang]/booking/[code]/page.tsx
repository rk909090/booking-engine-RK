import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SiteShell } from "@/components/site/site-shell";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { todayIn } from "@/domain/dates";
import { guaranteeDue } from "@/domain/guarantee";
import { refundOutstanding } from "@/domain/operations";
import { balanceDue, cancellationOutcome } from "@/domain/pricing";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatDateRange, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { verifyBookingAccessToken } from "@/lib/booking/access";
import { cancelBookingAsGuest } from "@/lib/booking/actions";
import { latestCheckoutUrl } from "@/lib/site/queries";

type Props = PageProps<"/[lang]/booking/[code]">;

export async function generateMetadata(): Promise<Metadata> {
  const lang = await rootLang();
  if (!hasLocale(lang)) return {};
  // The URL carries an access token: keep it out of referrers and search engines.
  return { title: (await getDictionary(lang)).booking.lookupTitle, referrer: "no-referrer", robots: { index: false } };
}

export default async function BookingPage({ params, searchParams }: Props) {
  const lang = await rootLang();
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <SiteShell lang={lang} dict={dict}>
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <Suspense fallback={<p className="text-stone">{dict.ops.loading}</p>}>
          <BookingDetails lang={lang} dict={dict} params={params} searchParams={searchParams} />
        </Suspense>
      </div>
    </SiteShell>
  );
}

async function BookingDetails({
  lang,
  dict,
  params,
  searchParams,
}: {
  lang: Locale;
  dict: Dictionary;
  params: Props["params"];
  searchParams: Props["searchParams"];
}) {
  const t = dict.booking;
  const [{ code }, sp] = await Promise.all([params, searchParams]);
  const token = typeof sp.t === "string" ? sp.t : undefined;
  if (!verifyBookingAccessToken(code, token)) {
    return (
      <div className="space-y-4">
        <ErrorNote>{t.notFound}</ErrorNote>
        <Link href={`/${lang}/booking`} className="text-lagoon underline-offset-4 hover:underline">
          {t.lookupTitle}
        </Link>
      </div>
    );
  }

  const [row] = await getDb()
    .select({
      reservation: schema.reservations,
      typeName: schema.unitTypes.name,
      propertyName: schema.properties.name,
      timezone: schema.properties.timezone,
    })
    .from(schema.reservations)
    .innerJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.reservations.unitTypeId))
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .where(eq(schema.reservations.code, code))
    .limit(1);
  if (!row) notFound();
  const r = row.reservation;
  const checkoutUrl = r.status === "hold" ? await latestCheckoutUrl(r.id) : null;
  const balance = balanceDue(r);
  const depositDue = guaranteeDue(r, todayIn(row.timezone));
  const policyOutcome =
    r.status === "confirmed"
      ? cancellationOutcome({
          tiers: r.policySnapshot?.cancellationTiers ?? [],
          total: r.totalAmount,
          amountPaid: r.amountPaid,
          checkIn: r.checkIn,
          today: todayIn(row.timezone),
        })
      : null;
  // Refunds already paid out (after a shortened stay) are not paid twice.
  const outcome = policyOutcome
    ? { ...policyOutcome, refund: await refundOutstanding(getDb(), r.id, policyOutcome.refund) }
    : null;
  const holdTime = r.holdExpiresAt
    ? new Intl.DateTimeFormat(lang === "id" ? "id-ID" : "en-GB", { timeStyle: "short", timeZone: row.timezone }).format(r.holdExpiresAt)
    : "";

  return (
    <div className="space-y-6">
      <div>
        <p className="font-mono text-sm text-stone">{format(t.title, { code: r.code })}</p>
        <h1 className="mt-1 font-display text-3xl text-lagoon">
          {r.status === "confirmed" || r.status === "in_house" || r.status === "checked_out"
            ? t.confirmedHeading
            : r.status === "hold"
              ? t.pendingHeading
              : r.status === "cancelled"
                ? t.cancelledHeading
                : r.refundAmount
                  ? t.needsRefundHeading
                  : t.expiredHeading}
        </h1>
      </div>

      {sp.declined ? <ErrorNote>{dict.pay.declined}</ErrorNote> : null}
      {r.status === "hold" ? (
        <div className="space-y-3">
          <p className="text-ink">{format(t.pendingIntro, { time: holdTime })}</p>
          {checkoutUrl ? (
            <a href={checkoutUrl} className="inline-block rounded-lg bg-lagoon px-4 py-2.5 font-medium text-ivory hover:bg-lagoon-deep">
              {t.continuePayment}
            </a>
          ) : null}
        </div>
      ) : null}
      {r.status === "expired" && !r.refundAmount ? <p className="text-ink">{t.expiredIntro}</p> : null}
      {r.status === "expired" && r.refundAmount ? (
        <p className="text-ink">{format(t.needsRefundIntro, { amount: formatMoney(r.refundAmount, lang) })}</p>
      ) : null}
      {r.status === "cancelled" && r.refundAmount ? (
        <SuccessNote>{format(t.refundDue, { amount: formatMoney(r.refundAmount, lang) })}</SuccessNote>
      ) : null}

      <dl className="grid gap-3 rounded-2xl border border-line bg-white/80 p-5 text-sm sm:grid-cols-2">
        <Item label={t.villa} value={`${row.typeName} · ${row.propertyName}`} />
        <Item label={t.dates} value={formatDateRange(r.checkIn, r.checkOut, lang)} />
        <Item label={t.guests} value={format(dict.search.guests, { count: r.adults + r.children })} />
        <Item label={dict.home.statusLabel} value={t.status[r.status]} />
        {r.discountAmount ? <Item label={t.discount} value={`−${formatMoney(r.discountAmount, lang)}`} /> : null}
        <Item label={t.total} value={formatMoney(r.totalAmount, lang)} />
        <Item label={t.paid} value={formatMoney(r.amountPaid, lang)} />
        {depositDue ? (
          <div className="sm:col-span-2 font-medium text-ink">
            {format(t.depositDue, { amount: formatMoney(depositDue.amount, lang), date: formatDate(depositDue.payBy, lang) })}
          </div>
        ) : null}
        {!depositDue && r.status === "confirmed" && balance > 0 && r.balanceDueDate ? (
          <div className="sm:col-span-2 text-ink">
            {format(t.balanceDue, { amount: formatMoney(balance, lang), date: formatDate(r.balanceDueDate, lang) })}
          </div>
        ) : null}
      </dl>

      <p className="text-xs text-stone">{t.saveLink}</p>

      {outcome ? (
        <section className="rounded-2xl border border-line p-5">
          <h2 className="font-display text-xl text-lagoon">{t.cancelTitle}</h2>
          <p className="mt-2 text-sm text-ink">
            {format(t.cancelPreview, { fee: formatMoney(outcome.fee, lang), refund: formatMoney(outcome.refund, lang) })}
          </p>
          <form action={cancelBookingAsGuest} className="mt-4 space-y-3">
            <input type="hidden" name="lang" value={lang} />
            <input type="hidden" name="code" value={r.code} />
            <input type="hidden" name="t" value={token} />
            <label className="flex items-start gap-3 text-sm text-ink">
              <input type="checkbox" name="confirm" required className="mt-1 h-4 w-4 accent-danger" />
              <span>{t.cancelConfirm}</span>
            </label>
            <button type="submit" className="rounded-lg border border-danger px-4 py-2 text-sm font-medium text-danger hover:bg-danger/5">
              {t.cancelButton}
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-stone">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}
