import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { OpsNav, OpsShell, StatusBadge, NoAccess } from "@/components/ops/ops-shell";
import { CopyField } from "@/components/ops/copy-field";
import { DiscountCard } from "@/components/ops/discount-card";
import { PreCheckinGuests } from "@/components/ops/pre-checkin-card";
import { FolioCard } from "@/components/ops/folio-card";
import { partyBalances } from "@/domain/folio";
import { TimeRequest, type TimeRequestView } from "@/components/ops/time-request";
import { StayChange } from "@/components/ops/stay-change";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { discountLimitBp } from "@/domain/discount";
import { earlyCheckinStatus } from "@/domain/early-checkin";
import { guaranteeDue } from "@/domain/guarantee";
import { eraseExpiredDocuments, preCheckinView } from "@/domain/pre-checkin";
import { diffDays } from "@/domain/dates";
import { lateCheckoutStatus } from "@/domain/late-checkout";
import { changeability, previewStayChange } from "@/domain/modify";
import { loadStayFacts, stayActions, type ActionState } from "@/domain/operations";
import { balanceDue } from "@/domain/pricing";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { channelStatus } from "@/lib/notifications/providers";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatDateRange, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can, type Action } from "@/lib/authz/permissions";
import {
  cancelAction,
  changePayByAction,
  checkInAction,
  checkOutAction,
  confirmWithoutDepositAction,
  noShowAction,
  recordPaymentAction,
  refundAction,
} from "@/lib/ops/actions";
import { getReservationForStaff, sameTypeUnits } from "@/lib/ops/queries";
import { offerLabel } from "@/lib/pricing-labels";

type Props = PageProps<"/[lang]/ops/reservations/[code]">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  return { title: code.toUpperCase() };
}

export default async function ReservationDetailPage({ params, searchParams }: Props) {
  const lang = await rootLang();
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <OpsShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Detail lang={lang} dict={dict} params={params} searchParams={searchParams} />
      </Suspense>
    </OpsShell>
  );
}

function timeFmt(lang: Locale, timeZone: string) {
  return new Intl.DateTimeFormat(lang === "id" ? "id-ID" : "en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone });
}

async function Detail({
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
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "reservation.view").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const [{ code }, sp] = await Promise.all([params, searchParams]);
  const t = dict.resDetail;
  const data = await getReservationForStaff(staff.actor, code);
  if (!data) {
    return (
      <>
        <OpsNav lang={lang} dict={dict} staff={staff} current="reservations" />
        <ErrorNote>{t.reasons.not_found}</ErrorNote>
      </>
    );
  }
  const { reservation: r, guest, unit, property } = data;
  const now = new Date();
  const facts = await loadStayFacts(getDb(), r, property.timezone, now);
  const actions = stayActions(facts);
  const balance = balanceDue(r);
  // The discount split as priced: plan and offer are shown on their own lines; what remains was given by staff.
  const staffDiscount = r.discountAmount - (r.priceSnapshot?.planDiscount ?? 0) - (r.priceSnapshot?.offer?.amount ?? 0);
  const fmt = timeFmt(lang, property.timezone);
  const holdLive = r.status === "hold" && r.holdExpiresAt !== null && r.holdExpiresAt > now;
  const openLink = holdLive ? data.payments.find((p) => p.status === "pending" && p.checkoutUrl && (!p.expiresAt || p.expiresAt > now)) : undefined;
  // Money the desk can take now: at least the deposit on a hold, or toward the balance.
  const collect =
    holdLive
      ? { min: r.depositAmount, max: r.totalAmount, hint:
            r.depositAmount === r.totalAmount
              ? format(t.collectHoldHintFull, { amount: formatMoney(r.totalAmount, lang) })
              : format(t.collectHoldHint, { min: formatMoney(r.depositAmount, lang) }),
        }
      : (r.status === "confirmed" || r.status === "in_house") && balance > 0
        ? { min: 1, max: balance, hint: format(t.collectBalanceHint, { amount: formatMoney(balance, lang) }) }
        : null;
  const canCollect = can(staff.actor, "payment.record", r.propertyId).allowed;
  const canGuarantee = can(staff.actor, "reservation.guarantee", r.propertyId).allowed;
  const depositDue = guaranteeDue(r, facts.today);
  // Document numbers past their retention are erased before the page shows anything.
  await eraseExpiredDocuments(getDb(), facts.today);
  const pre = await preCheckinView(getDb(), r.id);
  const messages = await getDb()
    .select()
    .from(schema.notificationOutbox)
    .where(eq(schema.notificationOutbox.reservationId, r.id))
    .orderBy(desc(schema.notificationOutbox.createdAt));
  const [folioCharges, folioParties, issuedInvoices] = await Promise.all([
    getDb().select().from(schema.folioCharges).where(eq(schema.folioCharges.reservationId, r.id)).orderBy(schema.folioCharges.chargeDate, schema.folioCharges.createdAt),
    partyBalances(getDb(), r.id),
    getDb().select({ partyId: schema.invoices.partyId, number: schema.invoices.number }).from(schema.invoices).where(eq(schema.invoices.reservationId, r.id)),
  ]);
  const channels = channelStatus();
  const inactiveChannels = (["email", "whatsapp"] as const).filter((c) => !channels[c]).map((c) => dict.messageLog.channels[c]);
  const regionName = new Intl.DisplayNames([lang === "id" ? "id-ID" : "en-GB"], { type: "region" });
  const ageAt = (birth: string, on: string) => Math.floor(diffDays(birth, on) / 365.25);
  const errorCode = typeof sp.error === "string" ? sp.error : null;

  // Change of dates / villa: the GET form puts the request in the URL.
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const changeAllowed = changeability(r.status).dates.allowed;
  const canModify = can(staff.actor, "reservation.modify", r.propertyId).allowed;
  const canMove = can(staff.actor, "reservation.move", r.propertyId).allowed;
  const requestedUnit = str(sp.unit);
  const request =
    changeAllowed && canModify && str(sp.newIn) && str(sp.newOut)
      ? {
          checkIn: str(sp.newIn),
          checkOut: str(sp.newOut),
          unitId: /^[0-9a-f-]{36}$/i.test(requestedUnit) && (canMove || requestedUnit === r.unitId) ? requestedUnit : r.unitId,
        }
      : null;
  const stayActive = r.status === "confirmed" || r.status === "in_house";
  const [preview, units, late, early] = await Promise.all([
    request ? previewStayChange(getDb(), { reservationId: r.id, ...request }) : null,
    changeAllowed && canModify ? sameTypeUnits(r.unitTypeId) : [],
    stayActive ? lateCheckoutStatus(getDb(), r.id, now) : null,
    r.status === "confirmed" ? earlyCheckinStatus(getDb(), r.id, now) : null,
  ]);
  const lateView: TimeRequestView | null = late
    ? {
        kind: "late",
        standardTime: late.check.standardCheckOut,
        turnoverMinutes: late.check.turnoverMinutes,
        other: late.check.nextArrival
          ? { code: late.check.nextArrival.code, guestName: late.check.nextArrival.guestName, time: late.check.nextArrival.arrivalTime, source: late.check.nextArrival.source }
          : null,
        limit: late.check.latestAllowed,
        conflict: late.check.conflict,
        request: late.request,
        stale: late.stale,
      }
    : null;
  const earlyView: TimeRequestView | null = early
    ? {
        kind: "early",
        standardTime: early.check.standardCheckIn,
        turnoverMinutes: early.check.turnoverMinutes,
        other: early.check.previousDeparture
          ? {
              code: early.check.previousDeparture.code,
              guestName: early.check.previousDeparture.guestName,
              time: early.check.previousDeparture.departureTime,
              source: early.check.previousDeparture.source,
            }
          : null,
        limit: early.check.earliestAllowed,
        conflict: early.check.conflict,
        request: early.request,
        stale: early.stale,
      }
    : null;
  // Errors from confirming a change are shown in the change card itself.
  const errorText =
    errorCode === "role"
      ? t.roleNotAllowed
      : errorCode && !request
        ? ((t.reasons as Record<string, string>)[errorCode] ?? t.reasons.not_found)
        : null;

  const gate = (action: Action, state: ActionState): { enabled: boolean; why?: string } => {
    if (!can(staff.actor, action, r.propertyId).allowed) return { enabled: false, why: t.roleNotAllowed };
    return state.allowed ? { enabled: true } : { enabled: false, why: t.reasons[state.reason] };
  };
  const hidden = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="code" value={r.code} />
    </>
  );

  return (
    <>
      <OpsNav lang={lang} dict={dict} staff={staff} current="reservations" />
      <Link href={`/${lang}/ops/reservations`} className="text-sm text-lagoon hover:underline">
        ← {t.back}
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-2xl text-lagoon">{r.code}</h1>
        <StatusBadge status={r.status} label={dict.booking.status[r.status]} />
        <span className="text-sm text-stone">{dict.resList.sources[r.source]}</span>
      </div>
      <p className="mt-1 text-lg text-ink">{guest.fullName}</p>

      <div className="mt-4 space-y-2">
        {sp.done ? <SuccessNote>{t.done}</SuccessNote> : null}
        {sp.created === "1" ? <SuccessNote>{t.created}</SuccessNote> : null}
        {sp.created === "link" && r.holdExpiresAt ? <SuccessNote>{format(t.createdLink, { time: fmt.format(r.holdExpiresAt) })}</SuccessNote> : null}
        {errorText ? <ErrorNote>{errorText}</ErrorNote> : null}
        {depositDue ? (
          <p
            role="status"
            className={`rounded-lg border px-4 py-3 text-sm ${depositDue.overdue ? "border-danger/40 bg-danger/5 text-danger" : "border-terracotta/40 bg-sand text-ink"}`}
          >
            {format(depositDue.overdue ? t.guaranteeOverdue : t.guaranteeOpen, {
              amount: formatMoney(depositDue.amount, lang),
              date: formatDate(depositDue.payBy, lang),
            })}{" "}
            <span className="text-stone">{format(t.guaranteeReasonLine, { reason: depositDue.terms.reason })}</span>
          </p>
        ) : null}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card title={t.stay}>
            <Grid>
              <Item label={t.stay} value={formatDateRange(r.checkIn, r.checkOut, lang)} />
              <Item label={t.unit} value={`${data.typeName} · ${unit.code} · ${property.name}`} />
              <Item label={t.guests} value={format(dict.search.guests, { count: r.adults + r.children })} />
              <Item label={t.arrival} value={r.estimatedArrival?.slice(0, 5) ?? t.none} />
            </Grid>
            {r.specialRequests ? (
              <p className="mt-3 rounded-lg bg-sand px-3 py-2 text-sm text-ink">
                <span className="font-medium">{t.requests}:</span> {r.specialRequests}
              </p>
            ) : null}
          </Card>

          <Card title={t.guestTitle}>
            <Grid>
              <Item label={t.email} value={guest.email ?? t.none} />
              <Item label={t.phone} value={guest.phone ?? t.none} />
            </Grid>
          </Card>

          <Card title={dict.preCheckinStaff.title}>
            {pre ? (
              <div className="space-y-3 text-sm">
                <p className="text-xs text-stone">{format(dict.preCheckinStaff.submitted, { time: fmt.format(pre.submittedAt) })}</p>
                <Grid>
                  <Item label={t.arrival} value={r.estimatedArrival?.slice(0, 5) ?? t.none} />
                  <Item
                    label={dict.preCheckinStaff.flight}
                    value={
                      pre.flightNumber
                        ? `${pre.flightNumber}${pre.landingDate ? ` · ${formatDate(pre.landingDate, lang)}` : ""}${pre.landingTime ? ` ${pre.landingTime.slice(0, 5)}` : ""}`
                        : t.none
                    }
                  />
                </Grid>
                {pre.transferRequested ? (
                  <p className="rounded-lg border border-terracotta/40 bg-sand px-3 py-2 text-ink">
                    <span className="font-medium">{dict.preCheckinStaff.transfer}</span>
                    {pre.transferNote ? ` · ${pre.transferNote}` : ""}
                  </p>
                ) : null}
                {pre.requests ? (
                  <p className="rounded-lg bg-sand px-3 py-2 text-ink">
                    <span className="font-medium">{t.requests}:</span> {pre.requests}
                  </p>
                ) : null}
                <PreCheckinGuests
                  lang={lang}
                  code={r.code}
                  canReveal={can(staff.actor, "reservation.check_in", r.propertyId).allowed}
                  t={dict.preCheckinStaff}
                  guests={pre.guests.map((g) => ({
                    ...g,
                    nationalityName: regionName.of(g.nationality) ?? g.nationality,
                    birthDate: formatDate(g.birthDate, lang),
                    age: ageAt(g.birthDate, r.checkIn),
                  }))}
                />
                <p className="text-xs text-stone">{format(dict.preCheckinStaff.rulesAccepted, { time: fmt.format(pre.houseRulesAcceptedAt) })}</p>
              </div>
            ) : (
              <p className="text-sm text-stone">{dict.preCheckinStaff.none}</p>
            )}
          </Card>

          <Card title={t.money}>
            <dl className="space-y-1 text-sm">
              <Line label={t.ratePlan} value={dict.pricing.plans[(r.ratePlan as keyof Dictionary["pricing"]["plans"]) ?? "standard"] ?? r.ratePlan} />
              <Line label={t.subtotal} value={formatMoney(r.subtotalAmount, lang)} />
              {r.priceSnapshot?.planDiscount ? <Line label={dict.pricing.planDiscount} value={`−${formatMoney(r.priceSnapshot.planDiscount, lang)}`} /> : null}
              {r.priceSnapshot?.offer ? <Line label={offerLabel(dict.pricing, r.priceSnapshot.offer)} value={`−${formatMoney(r.priceSnapshot.offer.amount, lang)}`} /> : null}
              {staffDiscount ? (
                <Line label={r.discount?.reason ? `${t.discountLine} (${r.discount.reason})` : t.discountLine} value={`−${formatMoney(staffDiscount, lang)}`} />
              ) : null}
              {r.breakfastAmount ? <Line label={format(dict.pricing.breakfastLine, { count: r.priceSnapshot?.nights.length ?? 0 })} value={formatMoney(r.breakfastAmount, lang)} /> : null}
              {r.serviceAmount ? <Line label={t.service} value={formatMoney(r.serviceAmount, lang)} /> : null}
              {r.taxAmount ? <Line label={t.tax} value={formatMoney(r.taxAmount, lang)} /> : null}
              {r.extrasAmount ? <Line label={t.extras} value={formatMoney(r.extrasAmount, lang)} /> : null}
              <Line label={t.total} value={formatMoney(r.totalAmount, lang)} strong />
              <Line label={t.paid} value={formatMoney(r.amountPaid, lang)} />
              {balance > 0 && r.status !== "cancelled" && r.status !== "no_show" && r.status !== "expired" ? (
                <Line
                  label={`${t.balance}${r.balanceDueDate ? ` (${format(t.balanceDue, { date: formatDate(r.balanceDueDate, lang) })})` : ""}`}
                  value={formatMoney(balance, lang)}
                  strong
                />
              ) : null}
              {r.refundAmount ? <Line label={t.refundOwed} value={formatMoney(r.refundAmount, lang)} /> : null}
              {facts.refundOutstanding > 0 ? (
                <Line label={t.refundOutstanding} value={formatMoney(facts.refundOutstanding, lang)} strong danger />
              ) : null}
            </dl>
            {r.priceSnapshot?.nights.length ? (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-lagoon">{t.nightly}</summary>
                <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                  {r.priceSnapshot.nights.map((n) => (
                    <li key={n.date} className="flex justify-between gap-2 text-stone">
                      <span>
                        {formatDate(n.date, lang)}
                        {n.season ? ` · ${n.season}` : ""}
                      </span>
                      <span className="text-ink">{formatMoney(n.rate, lang)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <h3 className="mt-5 text-xs font-semibold uppercase tracking-[0.15em] text-terracotta-deep">{t.paymentsTitle}</h3>
            {data.payments.length === 0 ? (
              <p className="mt-2 text-sm text-stone">{t.noPayments}</p>
            ) : (
              <ul className="mt-2 divide-y divide-line text-sm">
                {data.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2">
                    <span className="text-ink">
                      {t.purpose[p.purpose]} · {p.provider}
                      <span className="block text-xs text-stone">{fmt.format(p.paidAt ?? p.createdAt)}</span>
                    </span>
                    <span className="text-right">
                      <span className={p.purpose === "refund" ? "text-danger" : "text-ink"}>
                        {p.purpose === "refund" ? "−" : ""}
                        {formatMoney(p.amount, lang)}
                      </span>
                      <span className="block text-xs text-stone">{t.paymentStatus[p.status]}</span>
                      {p.folioPartyId ? (
                        <span className="block text-xs text-terracotta-deep">{folioParties.find((x) => x.id === p.folioPartyId)?.name}</span>
                      ) : null}
                      {p.status === "paid" && p.purpose !== "refund" ? (
                        <Link href={`/${lang}/ops/reservations/${r.code}/receipt/${p.id}`} className="block text-xs text-lagoon hover:underline">
                          {dict.folio.receipt}
                        </Link>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={dict.folio.title}>
            <FolioCard
              lang={lang}
              dict={dict}
              code={r.code}
              charges={folioCharges}
              parties={folioParties}
              invoices={issuedInvoices}
              canCharge={can(staff.actor, "folio.charge", r.propertyId).allowed}
              canCollect={canCollect}
              open={r.status === "confirmed" || r.status === "in_house" || r.status === "checked_out"}
            />
          </Card>

          <Card title={dict.messageLog.title}>
            {inactiveChannels.length ? (
              <p className="mb-2 text-xs text-stone">{format(dict.messageLog.inactive, { channels: inactiveChannels.join(" & ") })}</p>
            ) : null}
            {messages.length === 0 ? (
              <p className="text-sm text-stone">{dict.messageLog.none}</p>
            ) : (
              <ul className="divide-y divide-line/60 text-sm">
                {messages.map((m) => (
                  <li key={m.id} className="flex flex-wrap justify-between gap-2 py-2">
                    <span className="text-ink">
                      {(dict.messageLog.kinds as Record<string, string>)[m.kind] ?? m.kind}
                      <span className="block text-xs text-stone">
                        {dict.messageLog.channels[m.channel as "email" | "whatsapp"] ?? m.channel} · {m.recipient}
                      </span>
                      {m.lastError && m.status !== "sent" ? <span className="block max-w-md truncate text-xs text-danger">{m.lastError}</span> : null}
                    </span>
                    <span className="text-right text-xs">
                      <span className={m.status === "sent" ? "text-lagoon" : m.status === "failed" ? "text-danger" : "text-stone"}>
                        {(dict.messageLog.status as Record<string, string>)[m.status] ?? m.status}
                      </span>
                      <span className="block text-stone">{fmt.format(m.sentAt ?? m.createdAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={t.activityTitle}>
            {data.activity.length === 0 ? (
              <p className="text-sm text-stone">{t.noActivity}</p>
            ) : (
              <ol className="space-y-2 text-sm">
                {data.activity.map((e) => (
                  <li key={e.id} className="flex flex-wrap justify-between gap-2 border-b border-line/60 pb-2 last:border-0">
                    <span className="text-ink">
                      {(t.activity as Record<string, string>)[e.action] ?? e.action}
                      <ChangeDetail action={e.action} before={e.before} after={e.after} lang={lang} dict={dict} />
                    </span>
                    <span className="text-xs text-stone">
                      {e.actorType === "staff" ? t.actorStaff : e.actorType === "guest" ? t.actorGuest : t.actorSystem} ·{" "}
                      {fmt.format(e.occurredAt)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <aside className="space-y-4">
          {openLink?.checkoutUrl ? (
            <Card title={t.payLinkTitle}>
              <p className="mb-2 text-xs text-stone">{format(t.payLinkHint, { time: fmt.format(openLink.expiresAt ?? r.holdExpiresAt!) })}</p>
              <CopyField value={openLink.checkoutUrl} copyLabel={t.copy} copiedLabel={t.copied} />
            </Card>
          ) : null}

          {collect && canCollect ? (
            <Card title={t.collectTitle}>
              <form action={recordPaymentAction} className="space-y-2">
                {hidden}
                <p className="text-xs text-stone">{collect.hint}</p>
                <label className="block space-y-1 text-xs text-stone">
                  <span>{t.collectAmount}</span>
                  <input name="amount" inputMode="numeric" required defaultValue={String(collect.min === 1 ? collect.max : collect.min)} className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink" />
                </label>
                <label className="block space-y-1 text-xs text-stone">
                  <span>{t.collectMethod}</span>
                  <select name="method" defaultValue="bank_transfer" className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink">
                    {(["cash", "bank_transfer", "card", "other"] as const).map((m) => (
                      <option key={m} value={m}>
                        {t.methods[m]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1 text-xs text-stone">
                  <span>{t.collectReference}</span>
                  <input name="reference" maxLength={200} className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink" />
                </label>
                <button type="submit" className="w-full rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
                  {t.collectSubmit}
                </button>
              </form>
            </Card>
          ) : null}

          {holdLive && canGuarantee ? (
            <Card title={t.guaranteeTitle}>
              <form action={confirmWithoutDepositAction} className="space-y-2">
                {hidden}
                <p className="text-xs text-stone">{format(t.guaranteeHint, { amount: formatMoney(r.depositAmount, lang) })}</p>
                <label className="block space-y-1 text-xs text-stone">
                  <span>{t.guaranteeReason}</span>
                  <input name="reason" required maxLength={300} className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink" />
                </label>
                <label className="block space-y-1 text-xs text-stone">
                  <span>{t.guaranteePayBy}</span>
                  <input
                    type="date"
                    name="payBy"
                    required
                    min={facts.today}
                    max={r.checkOut}
                    defaultValue={r.checkIn}
                    className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink"
                  />
                </label>
                <button type="submit" className="w-full rounded-lg border border-lagoon px-4 py-2 text-sm font-medium text-lagoon hover:bg-lagoon-soft">
                  {t.guaranteeSubmit}
                </button>
              </form>
            </Card>
          ) : null}

          {depositDue && canGuarantee ? (
            <Card title={t.guaranteeTitle}>
              <form action={changePayByAction} className="space-y-2">
                {hidden}
                <label className="block space-y-1 text-xs text-stone">
                  <span>{t.guaranteePayBy}</span>
                  <input
                    type="date"
                    name="payBy"
                    required
                    min={facts.today}
                    max={r.checkOut}
                    defaultValue={depositDue.payBy < facts.today ? facts.today : depositDue.payBy}
                    className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink"
                  />
                </label>
                <button type="submit" className="w-full rounded-lg border border-line px-4 py-2 text-sm text-ink hover:bg-sand">
                  {t.payBySubmit}
                </button>
              </form>
            </Card>
          ) : null}

          <Card title={t.actionsTitle}>
            <div className="space-y-4">
              <ActionForm gate={gate("reservation.check_in", actions.checkIn)} action={checkInAction} label={t.checkIn} hidden={hidden} />
              <ActionForm gate={gate("reservation.check_out", actions.checkOut)} action={checkOutAction} label={t.checkOut} hidden={hidden}>
                {balance > 0 ? (
                  <Check name="acknowledgeBalance" label={format(t.acknowledgeBalance, { amount: formatMoney(balance, lang) })} />
                ) : null}
              </ActionForm>
              <ActionForm gate={gate("reservation.no_show", actions.noShow)} action={noShowAction} label={t.noShow} hidden={hidden} danger>
                <Check name="confirm" label={t.confirmNoShow} required />
              </ActionForm>
              <ActionForm gate={gate("reservation.cancel", actions.cancel)} action={cancelAction} label={t.cancel} hidden={hidden} danger>
                <label className="block space-y-1 text-xs text-stone">
                  <span>{t.cancelReason}</span>
                  <input name="reason" maxLength={500} className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink" />
                </label>
                <Check name="confirm" label={t.confirmCancel} required />
              </ActionForm>
            </div>
          </Card>

          {changeAllowed && canModify ? (
            <Card title={dict.stayChange.title}>
              <StayChange
                lang={lang}
                dict={dict}
                reservation={r}
                units={units}
                today={facts.today}
                canMove={canMove}
                request={request}
                preview={preview}
                priceChanged={errorCode === "price_changed"}
              />
            </Card>
          ) : null}

          {stayActive && can(staff.actor, "reservation.discount", r.propertyId).allowed ? (
            <Card title={t.discountTitle}>
              <DiscountCard
                lang={lang}
                dict={dict}
                code={r.code}
                amount={r.discountAmount}
                terms={r.discount ?? null}
                limitBp={discountLimitBp(property, staff.actor.role)}
              />
            </Card>
          ) : null}

          {earlyView && (canModify || earlyView.request) ? (
            <Card title={dict.earlyCheckin.title}>
              <TimeRequest lang={lang} dict={dict} code={r.code} date={r.checkIn} view={earlyView} canEdit={canModify} />
            </Card>
          ) : null}

          {lateView && (canModify || lateView.request) ? (
            <Card title={dict.lateCheckout.title}>
              <TimeRequest lang={lang} dict={dict} code={r.code} date={r.checkOut} view={lateView} canEdit={canModify} />
            </Card>
          ) : null}

          {facts.refundOutstanding > 0 ? (
            <Card title={t.refundTitle}>
              <ActionForm gate={gate("payment.refund", actions.refund)} action={refundAction} label={t.refundSubmit} hidden={hidden}>
                <label className="block space-y-1 text-xs text-stone">
                  <span>{t.refundAmount}</span>
                  <input
                    name="amount"
                    inputMode="numeric"
                    required
                    defaultValue={String(facts.refundOutstanding)}
                    className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink"
                  />
                </label>
                <label className="block space-y-1 text-xs text-stone">
                  <span>{t.refundReference}</span>
                  <input name="reference" required maxLength={200} className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink" />
                </label>
              </ActionForm>
            </Card>
          ) : null}
        </aside>
      </div>
    </>
  );
}

/** "10 Feb – 12 Feb · RVP-01 → 10 Feb – 14 Feb · RVP-03" for date changes and moves. */
function ChangeDetail({ action, before, after, lang, dict }: { action: string; before: unknown; after: unknown; lang: Locale; dict: Dictionary }) {
  if (action !== "reservation.modified" && action !== "reservation.moved") return null;
  type Side = { checkIn?: string; checkOut?: string; unitCode?: string; total?: number };
  const b = (before ?? {}) as Side;
  const a = (after ?? {}) as Side;
  if (!b.checkIn || !b.checkOut || !a.checkIn || !a.checkOut) return null;
  const side = (s: Side) => `${formatDateRange(s.checkIn!, s.checkOut!, lang)}${s.unitCode ? ` · ${s.unitCode}` : ""}`;
  return (
    <span className="block text-xs text-stone">
      {format(dict.stayChange.change, { from: side(b), to: side(a) })}
      {typeof b.total === "number" && typeof a.total === "number" && a.total !== b.total
        ? ` · ${format(dict.stayChange.change, { from: formatMoney(b.total, lang), to: formatMoney(a.total, lang) })}`
        : ""}
    </span>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-white/70 p-5">
      <h2 className="mb-3 font-display text-xl text-lagoon">{title}</h2>
      {children}
    </section>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <dl className="grid gap-3 text-sm sm:grid-cols-2">{children}</dl>;
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-stone">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}

function Line({ label, value, strong, danger }: { label: string; value: string; strong?: boolean; danger?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? "font-medium" : ""} ${danger ? "text-danger" : strong ? "text-ink" : "text-stone"}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Check({ name, label, required }: { name: string; label: string; required?: boolean }) {
  return (
    <label className="flex items-start gap-2 text-xs text-ink">
      <input type="checkbox" name={name} required={required} className="mt-0.5 h-4 w-4 accent-lagoon" />
      <span>{label}</span>
    </label>
  );
}

/** A plain form per action: works without JavaScript; disabled actions say why. */
function ActionForm({
  gate,
  action,
  label,
  hidden,
  danger,
  children,
}: {
  gate: { enabled: boolean; why?: string };
  action: (form: FormData) => Promise<void>;
  label: string;
  hidden: ReactNode;
  danger?: boolean;
  children?: ReactNode;
}) {
  if (!gate.enabled) {
    return (
      <div>
        <button type="button" disabled className="w-full cursor-not-allowed rounded-lg border border-line px-4 py-2 text-sm text-stone/70">
          {label}
        </button>
        <p className="mt-1 text-xs text-stone">{gate.why}</p>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-2">
      {hidden}
      {children}
      <button
        type="submit"
        className={
          danger
            ? "w-full rounded-lg border border-danger px-4 py-2 text-sm font-medium text-danger hover:bg-danger/5"
            : "w-full rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep"
        }
      >
        {label}
      </button>
    </form>
  );
}
