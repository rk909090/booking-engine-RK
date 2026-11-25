import type { DiscountTerms } from "@/domain/types";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatMoney } from "@/i18n/formatters";
import type { Dictionary } from "@/i18n/get-dictionary";
import { setDiscountAction } from "@/lib/ops/actions";

const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";

/** Give, change or remove a booking's discount within the staff member's ceiling. */
export function DiscountCard({
  lang,
  dict,
  code,
  amount,
  terms,
  limitBp,
}: {
  lang: Locale;
  dict: Dictionary;
  code: string;
  amount: number;
  terms: DiscountTerms | null;
  limitBp: number;
}) {
  const t = dict.resDetail;
  const n = dict.newBooking;
  const hidden = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="code" value={code} />
    </>
  );
  const pct = (bp: number) => (bp / 100).toLocaleString(lang === "id" ? "id-ID" : "en-GB");

  return (
    <div className="space-y-3 text-sm">
      {terms && amount > 0 ? (
        <p className="font-medium text-ink">
          {format(t.discountCurrent, {
            amount: formatMoney(amount, lang),
            how: terms.kind === "percent" ? format(t.discountPercentOf, { percent: pct(terms.bp) }) : t.discountFixed,
            reason: terms.reason,
          })}
        </p>
      ) : (
        <p className="text-xs text-stone">{t.discountNone}</p>
      )}
      <p className="text-xs text-stone">{format(t.discountLimit, { limit: pct(limitBp) })}</p>
      <form action={setDiscountAction} className="space-y-2">
        {hidden}
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1 text-xs text-stone">
            <span>{n.discountKind}</span>
            <select name="discountKind" defaultValue={terms?.kind ?? "percent"} className={input}>
              <option value="percent">{n.discountPercent}</option>
              <option value="amount">{n.discountAmount}</option>
            </select>
          </label>
          <label className="block space-y-1 text-xs text-stone">
            <span>{n.discountValue}</span>
            <input
              name="discountValue"
              inputMode="decimal"
              required
              defaultValue={terms ? (terms.kind === "percent" ? String(terms.bp / 100) : String(terms.amount)) : ""}
              className={input}
            />
          </label>
        </div>
        <label className="block space-y-1 text-xs text-stone">
          <span>{n.discountReason}</span>
          <input name="discountReason" required maxLength={300} defaultValue={terms?.reason ?? ""} className={input} />
        </label>
        <button type="submit" className="w-full rounded-lg border border-lagoon px-4 py-2 text-sm font-medium text-lagoon hover:bg-lagoon-soft">
          {t.discountApply}
        </button>
      </form>
      {terms && amount > 0 ? (
        <form action={setDiscountAction}>
          {hidden}
          <input type="hidden" name="remove" value="1" />
          <button type="submit" className="w-full rounded-lg border border-line px-4 py-2 text-sm text-ink hover:bg-sand">
            {t.discountRemove}
          </button>
        </form>
      ) : null}
    </div>
  );
}
