import type { Metadata } from "next";
import { lang as rootLang } from "next/root-params";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { OpsNav, OpsShell, StatusBadge, NoAccess } from "@/components/ops/ops-shell";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { loadStayFacts, stayActions, type ActionState } from "@/domain/operations";
import { getDb } from "@/db/client";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatDateRange, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can, type Action } from "@/lib/authz/permissions";
import { cancelAction, checkInAction, checkOutAction, noShowAction, refundAction } from "@/lib/ops/actions";
import { getReservationForStaff } from "@/lib/ops/queries";

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
  const facts = await loadStayFacts(getDb(), r, property.timezone, new Date());
  const actions = stayActions(facts);
  const balance = r.totalAmount - r.amountPaid;
  const fmt = timeFmt(lang, property.timezone);
  const errorCode = typeof sp.error === "string" ? sp.error : null;
  const errorText =
    errorCode === "role" ? t.roleNotAllowed : errorCode ? (t.reasons as Record<string, string>)[errorCode] ?? t.reasons.not_found : null;

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
        {errorText ? <ErrorNote>{errorText}</ErrorNote> : null}
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

          <Card title={t.money}>
            <dl className="space-y-1 text-sm">
              <Line label={t.subtotal} value={formatMoney(r.subtotalAmount, lang)} />
              {r.serviceAmount ? <Line label={t.service} value={formatMoney(r.serviceAmount, lang)} /> : null}
              {r.taxAmount ? <Line label={t.tax} value={formatMoney(r.taxAmount, lang)} /> : null}
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
                    <span className="text-ink">{(t.activity as Record<string, string>)[e.action] ?? e.action}</span>
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
