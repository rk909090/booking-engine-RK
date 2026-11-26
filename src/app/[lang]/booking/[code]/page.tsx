import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SiteShell } from "@/components/site/site-shell";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { diffDays, isIsoDate, todayIn } from "@/domain/dates";
import { guaranteeDue } from "@/domain/guarantee";
import { guestLateCheckout } from "@/domain/late-checkout";
import { preCheckinOpen, preCheckinView } from "@/domain/pre-checkin";
import { PreCheckinForm } from "@/components/site/pre-checkin-form";
import { countryOptions } from "@/lib/countries";
import { refundOutstanding } from "@/domain/operations";
import { balanceDue, cancellationOutcome } from "@/domain/pricing";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatDateRange, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { verifyBookingAccessToken } from "@/lib/booking/access";
import { cancelAddonFromPortal, cancelBookingAsGuest, cancelLateCheckoutFromPortal, requestAddonFromPortal, requestLateCheckoutFromPortal } from "@/lib/booking/actions";
import { AddonFields } from "@/components/addon-fields";
import { DateChangeSection, EarlyCheckinSection, type DateChangeView } from "@/components/site/guest-requests";
import { latestDateChange, previewGuestDateChange } from "@/domain/date-change";
import { guestEarlyCheckin } from "@/domain/early-checkin";
import { activeAddons, addonChargesOnBill, addonOrdersFor } from "@/domain/addons";
import { addonViews } from "@/lib/addon-views";
import { stayDays } from "@/lib/addon-input";
import { offerLabel } from "@/lib/pricing-labels";
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
      checkInTime: schema.properties.checkInTime,
      checkOutTime: schema.properties.checkOutTime,
      propertyContent: schema.properties.content,
    })
    .from(schema.reservations)
    .innerJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.reservations.unitTypeId))
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .where(eq(schema.reservations.code, code))
    .limit(1);
  if (!row) notFound();
  const r = row.reservation;
  const otherDiscount = r.discountAmount - (r.priceSnapshot?.planDiscount ?? 0) - (r.priceSnapshot?.offer?.amount ?? 0);
  const checkoutUrl = r.status === "hold" ? await latestCheckoutUrl(r.id) : null;
  const balance = balanceDue(r);
  const depositDue = guaranteeDue(r, todayIn(row.timezone));
  const late = r.status === "confirmed" || r.status === "in_house" ? await guestLateCheckout(getDb(), r.id) : null;
  const early = r.status === "confirmed" ? await guestEarlyCheckin(getDb(), r.id) : null;
  const dateRequest = await latestDateChange(getDb(), r.id);
  const ci = typeof sp.ci === "string" && isIsoDate(sp.ci) ? sp.ci : null;
  const co = typeof sp.co === "string" && isIsoDate(sp.co) ? sp.co : null;
  const datePreview = r.status === "confirmed" && ci && co ? await previewGuestDateChange(getDb(), { reservationId: r.id, checkIn: ci, checkOut: co }) : null;
  const dateView: DateChangeView | null =
    r.status === "confirmed" && r.checkIn >= todayIn(row.timezone)
      ? {
          request: dateRequest ? { status: dateRequest.status, checkIn: dateRequest.checkIn, checkOut: dateRequest.checkOut, quotedTotal: dateRequest.quotedTotal, declineReason: dateRequest.declineReason } : null,
          preview: datePreview && ci && co ? (datePreview.ok ? { checkIn: ci, checkOut: co, ...datePreview } : { checkIn: ci, checkOut: co, ok: false, error: datePreview.error, minNights: datePreview.minNights, maxNights: datePreview.maxNights }) : null,
          current: { checkIn: r.checkIn, checkOut: r.checkOut, total: r.totalAmount },
          today: todayIn(row.timezone),
        }
      : null;
  const canOrderAddons = r.status === "confirmed" || r.status === "in_house";
  const addonCatalog = canOrderAddons ? addonViews(await activeAddons(getDb(), r.propertyId), lang, dict) : [];
  const addonOrders = await addonOrdersFor(getDb(), r.id);
  const addonDates = stayDays(r.checkIn, r.checkOut).map((d) => ({ value: d, label: formatDate(d, lang, { weekday: "short", day: "numeric", month: "short" }) }));
  const addonMessage = typeof sp.addon === "string" ? (dict.addons.messages as Record<string, string>)[sp.addon] ?? (dict.addons.errors as Record<string, string>)[sp.addon] : undefined;
  const today = todayIn(row.timezone);
  const preOpen = preCheckinOpen(r, today);
  const pre = r.status === "confirmed" || r.status === "in_house" ? await preCheckinView(getDb(), r.id) : null;
  const editingPre = preOpen && (!pre || sp.edit === "precheckin");
  const [guestInvoice] = await getDb()
    .select({ number: schema.invoices.number })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.reservationId, r.id), isNull(schema.invoices.partyId)))
    .limit(1);
  const houseRules = row.propertyContent.houseRules?.[lang]?.length
    ? row.propertyContent.houseRules[lang]
    : Object.values(dict.preCheckin.defaultRules).map((rule) => format(rule, { checkIn: row.checkInTime.slice(0, 5), checkOut: row.checkOutTime.slice(0, 5) }));
  const lateMessage = typeof sp.late === "string" ? (t.lateMessages as Record<string, string>)[sp.late] : undefined;
  const policyOutcome =
    r.status === "confirmed"
      ? cancellationOutcome({
          tiers: r.policySnapshot?.cancellationTiers ?? [],
          // Add-ons not yet delivered are refunded in full: the fee is on the stay only.
          total: r.totalAmount - (await addonChargesOnBill(getDb(), r.id)).total,
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
        {r.ratePlan !== "standard" ? <Item label={t.ratePlan} value={dict.pricing.plans[r.ratePlan as "non_refundable" | "breakfast"] ?? r.ratePlan} /> : null}
        {/* The discount split as it was priced: plan, the one offer that applied, then a staff discount. */}
        {r.priceSnapshot?.planDiscount ? <Item label={dict.pricing.planDiscount} value={`−${formatMoney(r.priceSnapshot.planDiscount, lang)}`} /> : null}
        {r.priceSnapshot?.offer ? <Item label={offerLabel(dict.pricing, r.priceSnapshot.offer)} value={`−${formatMoney(r.priceSnapshot.offer.amount, lang)}`} /> : null}
        {otherDiscount > 0 ? <Item label={t.discount} value={`−${formatMoney(otherDiscount, lang)}`} /> : null}
        {r.breakfastAmount ? <Item label={format(dict.pricing.breakfastLine, { count: r.priceSnapshot?.nights.length ?? 0 })} value={formatMoney(r.breakfastAmount, lang)} /> : null}
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
        {!depositDue && (r.status === "confirmed" || r.status === "in_house") && balance > 0 && !r.balanceDueDate ? (
          <div className="sm:col-span-2 text-ink">{format(t.balanceOutstanding, { amount: formatMoney(balance, lang) })}</div>
        ) : null}
      </dl>

      {preOpen || pre ? (
        <section className="rounded-2xl border border-line p-5" aria-labelledby="pre-title">
          <h2 id="pre-title" className="font-display text-xl text-lagoon">
            {dict.preCheckin.title}
          </h2>
          {sp.precheckin === "saved" || sp.precheckin === "updated" ? <SuccessNote>{dict.preCheckin.saved}</SuccessNote> : null}
          {editingPre ? (
            <div className="mt-3 space-y-3">
              <p className="text-sm text-stone">{dict.preCheckin.intro}</p>
              <PreCheckinForm
                lang={lang}
                code={r.code}
                token={token ?? ""}
                adults={r.adults}
                checkIn={r.checkIn}
                today={today}
                countries={countryOptions(lang)}
                houseRules={houseRules}
                t={dict.preCheckin}
                saved={
                  pre
                    ? {
                        arrivalTime: r.estimatedArrival?.slice(0, 5) ?? "",
                        flightNumber: pre.flightNumber ?? "",
                        landingDate: pre.landingDate ?? "",
                        landingTime: pre.landingTime?.slice(0, 5) ?? "",
                        transferRequested: pre.transferRequested,
                        transferNote: pre.transferNote ?? "",
                        requests: pre.requests ?? "",
                        guests: pre.guests,
                      }
                    : null
                }
              />
            </div>
          ) : pre ? (
            <div className="mt-2 space-y-2 text-sm text-ink">
              <p>{format(dict.preCheckin.done, { guests: pre.guests.map((g) => g.fullName).join(", ") })}</p>
              {pre.transferRequested ? <p className="text-stone">{dict.preCheckin.transferAsked}</p> : null}
              {preOpen ? (
                <Link href={`/${lang}/booking/${r.code}?t=${token}&edit=precheckin#pre-title`} className="inline-block text-lagoon underline-offset-4 hover:underline">
                  {dict.preCheckin.edit}
                </Link>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {late ? (
        <section className="rounded-2xl border border-line p-5" aria-labelledby="late-title">
          <h2 id="late-title" className="font-display text-xl text-lagoon">
            {t.lateTitle}
          </h2>
          {lateMessage ? (
            sp.late === "sent" || sp.late === "withdrawn" ? (
              <SuccessNote>{lateMessage}</SuccessNote>
            ) : (
              <ErrorNote>{lateMessage}</ErrorNote>
            )
          ) : null}
          {late.request?.status === "requested" ? (
            <div className="mt-2 space-y-3 text-sm text-ink">
              <p>{format(t.lateRequested, { time: late.request.time })}</p>
              <form action={cancelLateCheckoutFromPortal}>
                <input type="hidden" name="lang" value={lang} />
                <input type="hidden" name="code" value={r.code} />
                <input type="hidden" name="t" value={token} />
                <button type="submit" className="rounded-lg border border-line px-4 py-2 text-sm text-ink hover:bg-sand">
                  {t.lateWithdraw}
                </button>
              </form>
            </div>
          ) : late.request?.status === "approved" ? (
            <p className="mt-2 text-sm font-medium text-ink">
              {late.request.fee > 0
                ? format(t.lateApprovedFee, { time: late.request.time, amount: formatMoney(late.request.fee, lang) })
                : format(t.lateApproved, { time: late.request.time })}
            </p>
          ) : (
            <div className="mt-2 space-y-3 text-sm text-ink">
              {late.request?.status === "declined" ? <p>{format(t.lateDeclined, { time: late.request.time })}</p> : null}
              {late.times.length > 0 ? (
                <form action={requestLateCheckoutFromPortal} className="space-y-3">
                  <p className="text-stone">{format(t.lateIntro, { time: late.standardCheckOut })}</p>
                  <input type="hidden" name="lang" value={lang} />
                  <input type="hidden" name="code" value={r.code} />
                  <input type="hidden" name="t" value={token} />
                  <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
                    <label className="space-y-1.5 font-medium">
                      <span className="block">{t.lateTime}</span>
                      <select name="time" required defaultValue={late.times[0]} className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-ink">
                        {late.times.map((time) => (
                          <option key={time} value={time}>
                            {time}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1.5 font-medium">
                      <span className="block">{t.lateNote}</span>
                      <input name="note" maxLength={500} className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-ink" />
                    </label>
                  </div>
                  <button type="submit" className="rounded-lg bg-lagoon px-4 py-2.5 font-medium text-ivory hover:bg-lagoon-deep">
                    {t.lateSubmit}
                  </button>
                </form>
              ) : (
                <p className="text-stone">{t.lateNone}</p>
              )}
            </div>
          )}
        </section>
      ) : null}

      {early ? <EarlyCheckinSection dict={dict} hidden={{ lang, code: r.code, token }} early={early} message={{ code: typeof sp.early === "string" ? sp.early : undefined }} /> : null}

      {dateView ? <DateChangeSection dict={dict} hidden={{ lang, code: r.code, token }} view={dateView} message={{ code: typeof sp.dates === "string" ? sp.dates : undefined }} /> : null}

      {addonOrders.length || addonCatalog.length ? (
        <section id="addons" className="scroll-mt-6 rounded-2xl border border-line p-5" aria-labelledby="addons-title">
          <h2 id="addons-title" className="font-display text-xl text-lagoon">
            {dict.addons.portalTitle}
          </h2>
          {addonMessage ? sp.addon === "sent" || sp.addon === "withdrawn" ? <SuccessNote>{addonMessage}</SuccessNote> : <ErrorNote>{addonMessage}</ErrorNote> : null}
          {addonOrders.length ? (
            <ul className="mt-3 divide-y divide-line text-sm">
              {addonOrders.map(({ order: o, addon: a }) => (
                <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="font-medium text-ink">{a.name[lang] || a.name.id}</span>
                    <span className="block text-xs text-stone">
                      {formatDate(o.serviceDate, lang, { weekday: "short", day: "numeric", month: "short" })}
                      {o.serviceTime ? ` · ${o.serviceTime.slice(0, 5)}` : ""} · {formatMoney(o.amount, lang)}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 text-xs">
                    <span className={o.status === "confirmed" ? "font-medium text-success" : o.status === "requested" ? "text-terracotta-deep" : "text-stone"}>{(dict.addons.status as Record<string, string>)[o.status]}</span>
                    {o.status === "requested" && o.source === "portal" ? (
                      <form action={cancelAddonFromPortal}>
                        <input type="hidden" name="lang" value={lang} />
                        <input type="hidden" name="code" value={r.code} />
                        <input type="hidden" name="t" value={token} />
                        <input type="hidden" name="orderId" value={o.id} />
                        <button type="submit" className="text-stone underline-offset-4 hover:underline">
                          {dict.addons.withdraw}
                        </button>
                      </form>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {addonCatalog.length ? (
            <div className="mt-4 space-y-3">
              <p className="text-sm text-stone">{dict.addons.portalIntro}</p>
              {addonCatalog.map((a) => (
                <details key={a.id} className="rounded-xl border border-line bg-white/70 p-4">
                  <summary className="cursor-pointer list-none">
                    <span className="flex flex-wrap justify-between gap-2 text-sm">
                      <span className="font-medium text-ink">{a.name}</span>
                      <span className="text-stone">{a.price}</span>
                    </span>
                    {a.description ? <span className="mt-1 block text-xs text-stone">{a.description}</span> : null}
                  </summary>
                  <form action={requestAddonFromPortal} className="mt-3 space-y-3">
                    <input type="hidden" name="lang" value={lang} />
                    <input type="hidden" name="code" value={r.code} />
                    <input type="hidden" name="t" value={token} />
                    <input type="hidden" name="addonId" value={a.id} />
                    <AddonFields addon={a} prefix="" t={dict.addons} dates={addonDates} guests={r.adults + r.children} nights={Math.max(1, diffDays(r.checkIn, r.checkOut))} />
                    <p className="text-xs text-stone">{format(dict.addons.leadNote, { hours: a.leadHours })}</p>
                    <button type="submit" className="rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
                      {dict.addons.request}
                    </button>
                  </form>
                </details>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {guestInvoice ? (
        <p className="text-sm">
          <Link href={`/${lang}/booking/${r.code}/invoice?t=${token}`} className="text-lagoon underline-offset-4 hover:underline">
            {format(dict.invoice.guestLink, { number: guestInvoice.number })}
          </Link>
        </p>
      ) : null}

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
