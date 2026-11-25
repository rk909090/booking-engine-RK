"use client";

import { useActionState, useState } from "react";
import { ErrorNote, Field, PrimaryButton } from "@/components/ui";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatMoney } from "@/i18n/formatters";
import type { Dictionary } from "@/i18n/get-dictionary";
import { createStaffBookingAction, type StaffBookingFormState } from "@/lib/ops/booking-actions";
import { parseDiscountInput } from "@/lib/ops/discount-input";

type Props = {
  lang: Locale;
  dict: Pick<Dictionary, "newBooking"> & { methods: Dictionary["resDetail"]["methods"]; sources: Dictionary["resList"]["sources"] };
  stay: { unitTypeId: string; checkIn: string; checkOut: string; adults: number; children: number };
  units: Array<{ id: string; code: string }>;
  /** The undiscounted price, with what is needed to recompute it after a discount (same rules as the server). */
  quote: { subtotal: number; total: number; dueNow: number; serviceRateBp: number; taxRateBp: number; depositRateBp: number; payInFull: boolean };
  /** This staff member's discount ceiling in basis points. */
  limitBp: number;
};

const bp = (amount: number, rate: number) => Math.round((amount * rate) / 10_000);

/** Mirrors domain/pricing: discount on the nights, then service, then tax; deposit on the total. */
function priced(quote: Props["quote"], kind: string, value: string) {
  const d = parseDiscountInput(kind, value);
  const off = !d ? 0 : Math.max(0, Math.min(quote.subtotal, d.kind === "percent" ? bp(quote.subtotal, d.bp || 0) : d.amount));
  const net = quote.subtotal - off;
  const service = bp(net, quote.serviceRateBp);
  const total = net + service + bp(net + service, quote.taxRateBp);
  return { off, total, dueNow: quote.payInFull ? total : bp(total, quote.depositRateBp) };
}

const box = "w-full rounded-lg border border-line bg-white px-3 py-2.5 text-ink outline-none focus:border-lagoon focus:ring-2 focus:ring-lagoon/20";

export function StaffBookingForm(props: Props) {
  const [state, action, pending] = useActionState<StaffBookingFormState, FormData>(createStaffBookingAction, {});
  // A new key after each failed attempt puts the submitted values back into the fields.
  return <Fields key={JSON.stringify(state)} {...props} state={state} action={action} pending={pending} />;
}

function Fields({
  lang,
  dict,
  stay,
  units,
  quote,
  limitBp,
  state,
  action,
  pending,
}: Props & { state: StaffBookingFormState; action: (form: FormData) => void; pending: boolean }) {
  const t = dict.newBooking;
  const v = state.values ?? {};
  const [mode, setMode] = useState(v.mode === "link" ? "link" : "received");
  const money = (n: number) => formatMoney(n, lang);
  const [discountKind, setDiscountKind] = useState(v.discountKind || "");
  const [discountValue, setDiscountValue] = useState(v.discountValue || "");
  const now = priced(quote, discountKind, discountValue);
  // Restored after an error only if staff typed it; otherwise it keeps following the price.
  const [amount, setAmount] = useState(v.amountTouched ? v.amount : "");
  const full = now.dueNow === now.total;
  const range = state.amountRange ?? { min: now.dueNow, max: now.total };
  const limit = (limitBp / 100).toLocaleString(lang === "id" ? "id-ID" : "en-GB");
  const errorText = !state.error
    ? null
    : state.error === "invalid_amount" && range.min === range.max
      ? format(t.errors.invalid_amount_full, { amount: money(range.max) })
      : format(t.errors[state.error], { min: money(range.min), max: money(range.max), limit: ((state.limitBp ?? limitBp) / 100).toString() });

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="unitTypeId" value={stay.unitTypeId} />
      <input type="hidden" name="checkIn" value={stay.checkIn} />
      <input type="hidden" name="checkOut" value={stay.checkOut} />
      <input type="hidden" name="adults" value={stay.adults} />
      <input type="hidden" name="children" value={stay.children} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.fullName} name="fullName" required maxLength={120} defaultValue={v.fullName} autoComplete="off" />
        <label className="space-y-1.5 text-sm font-medium text-ink">
          <span className="block">{t.source}</span>
          <select name="source" defaultValue={v.source || "direct"} className={box}>
            {(["direct", "walk_in", "agent"] as const).map((s) => (
              <option key={s} value={s}>
                {dict.sources[s]}
              </option>
            ))}
          </select>
        </label>
        <Field label={t.email} name="email" type="email" maxLength={200} defaultValue={v.email} autoComplete="off" />
        <Field label={t.phone} name="phone" type="tel" maxLength={40} defaultValue={v.phone} autoComplete="off" />
      </div>
      <p className="-mt-2 text-xs text-stone">{t.contactHint}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t.country} name="country" maxLength={2} defaultValue={v.country} autoComplete="off" />
        <Field label={t.arrival} name="arrival" type="time" defaultValue={v.arrival} />
        <label className="space-y-1.5 text-sm font-medium text-ink">
          <span className="block">{t.unit}</span>
          <select name="unitId" defaultValue={v.unitId || ""} className={box}>
            <option value="">{t.unitAuto}</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.code}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block space-y-1.5 text-sm font-medium text-ink">
        <span className="block">{t.requests}</span>
        <textarea name="requests" rows={2} maxLength={2000} defaultValue={v.requests} className={box} />
      </label>

      {limitBp > 0 ? (
        <fieldset className="space-y-3 rounded-xl border border-line p-4">
          <legend className="px-1 text-sm font-medium text-ink">{t.discountTitle}</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1.5 text-sm font-medium text-ink">
              <span className="block">{t.discountKind}</span>
              <select name="discountKind" value={discountKind} onChange={(e) => setDiscountKind(e.target.value)} className={box}>
                <option value="">{t.discountNone}</option>
                <option value="percent">{t.discountPercent}</option>
                <option value="amount">{t.discountAmount}</option>
              </select>
            </label>
            {discountKind ? (
              <>
                <Field label={t.discountValue} name="discountValue" inputMode="decimal" required value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} />
                <Field label={t.discountReason} name="discountReason" required maxLength={300} defaultValue={v.discountReason} autoComplete="off" />
              </>
            ) : null}
          </div>
          <p className="text-xs text-stone">
            {format(t.discountLimit, { limit })}
            {now.off > 0 ? ` ${format(t.afterDiscount, { total: money(now.total), dueNow: money(now.dueNow) })}` : ""}
          </p>
        </fieldset>
      ) : null}

      <fieldset className="space-y-3 rounded-xl border border-line p-4">
        <legend className="px-1 text-sm font-medium text-ink">{t.paymentTitle}</legend>
        <label className="flex items-start gap-2 text-sm text-ink">
          <input type="radio" name="mode" value="received" checked={mode === "received"} onChange={() => setMode("received")} className="mt-1 accent-lagoon" />
          <span>
            {t.modeReceived}
            <span className="block text-xs text-stone">
              {full ? format(t.modeReceivedHintFull, { amount: money(now.total) }) : format(t.modeReceivedHint, { min: money(now.dueNow), max: money(now.total) })}
            </span>
          </span>
        </label>
        {mode === "received" ? (
          <div className="grid gap-3 pl-6 sm:grid-cols-3">
            {/* Follows the price (and discount) until staff type their own amount. */}
            <Field label={t.amount} name="amount" inputMode="numeric" required value={amount || String(now.dueNow)} onChange={(e) => setAmount(e.target.value)} />
            <input type="hidden" name="amountTouched" value={amount ? "1" : ""} />
            <label className="space-y-1.5 text-sm font-medium text-ink">
              <span className="block">{t.method}</span>
              <select name="method" defaultValue={v.method || "bank_transfer"} className={box}>
                {(["cash", "bank_transfer", "card", "other"] as const).map((m) => (
                  <option key={m} value={m}>
                    {dict.methods[m]}
                  </option>
                ))}
              </select>
            </label>
            <Field label={t.reference} name="reference" maxLength={200} defaultValue={v.reference} autoComplete="off" />
          </div>
        ) : null}
        <label className="flex items-start gap-2 text-sm text-ink">
          <input type="radio" name="mode" value="link" checked={mode === "link"} onChange={() => setMode("link")} className="mt-1 accent-lagoon" />
          <span>
            {t.modeLink}
            <span className="block text-xs text-stone">{format(t.modeLinkHint, { amount: money(now.dueNow) })}</span>
          </span>
        </label>
        {mode === "link" ? (
          <label className="block space-y-1.5 pl-6 text-sm font-medium text-ink sm:w-1/3">
            <span className="block">{t.holdFor}</span>
            <select name="holdHours" defaultValue={v.holdHours || "24"} className={box}>
              {(["1", "24", "48"] as const).map((h) => (
                <option key={h} value={h}>
                  {t.hold[h]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </fieldset>

      <ErrorNote>{errorText}</ErrorNote>
      <PrimaryButton type="submit" disabled={pending}>
        {pending ? t.working : t.submit}
      </PrimaryButton>
    </form>
  );
}
